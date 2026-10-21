// lib/importer.js — 导入任务：音频 → 识别 → 翻译讲解 → 一节课
//
// 一次只跑一个（识别吃 CPU）。每一步做完就存盘：DSH 中途退出，下次打开点「继续」从断点接着翻译。
// 模型不可用时也能出课（只有英文），之后再「补全翻译」。

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { compactAudio, mergeSegments, transcribe } from './asr.js'
import { ensureModels } from './models.js'
import { audioPath, getLesson, makeId, saveLesson, titleFromFile } from './store.js'
import { summarizeLesson, translateSentences } from './translate.js'
import { buildDocAudio, buildTrack, TRACKS } from './tracks.js'
import { MAX_CHARS, parseDoc } from './doc.js'
import { cleanupText, estimate, plainTidy } from './docprep.js'
import { extractText } from './extract.js'
import { dataRoot } from './paths.js'
import { createHash } from 'node:crypto'
import { getVpsConfig, sendLesson } from './vps.js'

export const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.wma', '.m4b', '.mp4', '.webm']
// 同名文件有好几种格式时（CD 抓轨常见 .flac + .mp3），只要一份，按这个顺序挑
const PREFER = ['.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.opus', '.flac', '.wav', '.wma', '.mp4', '.webm']

/** 一个文件或一个文件夹 → 要导入的音频文件（文件夹只看第一层，按文件名排序） */
export async function resolveInputs(input) {
  const p = resolve(String(input || '').trim().replace(/^['"]|['"]$/g, ''))
  let st
  try { st = await stat(p) } catch { throw Object.assign(new Error(`找不到：${p}`), { status: 400 }) }
  if (st.isFile()) {
    if (!AUDIO_EXT.includes(extname(p).toLowerCase())) throw Object.assign(new Error('不是音频文件（支持 mp3、m4a、wav、flac 等）'), { status: 400 })
    return [p]
  }
  const names = (await readdir(p)).filter(n => !n.startsWith('.') && AUDIO_EXT.includes(extname(n).toLowerCase()))
  const byBase = new Map()
  for (const n of names) {
    const base = basename(n, extname(n))
    const cur = byBase.get(base)
    const rank = x => PREFER.indexOf(extname(x).toLowerCase())
    if (!cur || rank(n) < rank(cur)) byBase.set(base, n)
  }
  const files = [...byBase.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(n => join(p, n))
  if (!files.length) throw Object.assign(new Error('这个文件夹里没有音频文件'), { status: 400 })
  return files
}

export class Importer {
  /**
   * @param {object} deps
   * @param {() => object|null} deps.llm 当前可用的模型（complete 接口）；没有返回 null
   * @param {() => object} [deps.options] { ffmpeg?, threads?, modelDir? }
   * @param {(msg:string)=>void} [deps.log]
   */
  constructor(deps) {
    this.deps = deps
    this.jobs = []
    this.running = null
    this.listeners = new Set()
  }

  opts() { return (this.deps.options && this.deps.options()) || {} }
  log(m) { if (this.deps.log) this.deps.log(m) }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  changed() { for (const fn of this.listeners) { try { fn() } catch { /* 忽略 */ } } }

  /** 给界面看的任务列表 */
  list() {
    return this.jobs.map(j => ({
      id: j.id, lessonId: j.lessonId, title: j.title, kind: j.kind, track: j.track, state: j.state, stage: j.stage,
      done: j.done, total: j.total, message: j.message, error: j.error, startedAt: j.startedAt, finishedAt: j.finishedAt,
    }))
  }

  /**
   * 导入一个文件 / 文件夹
   * @param {string} input 路径
   * @param {{title?:string, group?:string, removeSource?:boolean, displayName?:string}} [extra]
   */
  async importPath(input, extra = {}) {
    const files = await resolveInputs(input)
    const folder = files.length > 1 ? basename(dirname(files[0])) : (extra.group || '')
    const out = []
    for (const [k, file] of files.entries()) {
      const st = await stat(file)
      const name = extra.displayName || basename(file)
      const id = makeId(extra.displayName ? `upload/${extra.displayName}` : file, st.size)
      const existing = await getLesson(id)
      if (existing && existing.status === 'ready' && existsSync(audioPath(id))) {
        // 单独导入过的课，后来又导入了它所在的整个文件夹：归进这个文件夹的组
        if (folder && (!existing.group || existing.group !== folder)) { existing.group = folder; existing.order = k; await saveLesson(existing) }
        out.push({ lessonId: id, existed: true, title: existing.title })
        if (extra.removeSource) await rm(file, { force: true })
        continue
      }
      const lesson = existing || {
        id,
        version: 1,
        title: (files.length === 1 && extra.title) || titleFromFile(name),
        group: folder,
        order: k,
        source: { file: extra.removeSource ? '' : file, name, size: st.size },
        status: 'queued',
        createdAt: Date.now(),
        sentences: [],
      }
      if (!existing) await saveLesson(lesson)
      this.enqueue({ kind: 'import', lessonId: id, title: lesson.title, file, removeSource: Boolean(extra.removeSource) })
      out.push({ lessonId: id, existed: false, title: lesson.title })
    }
    return out
  }

  /**
   * 导入文档第一步：取出文字、存档、预估，等用户确认（不调用 AI）
   * @param {string} file 上传或本机的文件；text 模式时为 null
   * @param {{name:string, text?:string, removeSource?:boolean}} o
   */
  async prepareDoc(file, o) {
    const ext = (/\.[a-z0-9]+$/i.exec(o.name || '') || ['.txt'])[0].toLowerCase()
    const r = file ? await extractText(file, o.name) : { type: '粘贴的文字', text: String(o.text || '') }
    if (r.scanned) throw Object.assign(new Error('这是扫描版 PDF（每页都是图片），读不出文字。先用手机或电脑的文字识别（OCR）、或让 AI 把它转成文字（.txt），再导入。'), { status: 400 })
    const text = r.text.trim()
    if ((text.match(/[A-Za-z]+/g) || []).length < 20) throw Object.assign(new Error('文档里几乎没有英文'), { status: 400 })
    if (text.length > MAX_CHARS) {
      throw Object.assign(new Error(`太长了：约 ${Math.round(text.length / 6 / 1000)} 千词。一次最多约 6 万词（${MAX_CHARS / 1000} 千字符，相当于 7 小时左右的朗读），拆成几份导入。`), { status: 400 })
    }
    // 已经是「# 章节」格式的 Markdown 不用 AI 再整理
    const formatted = (ext === '.md' || ext === '.markdown' || !file) && /^#\s+\S/m.test(text)
    const llm = this.deps.llm()
    const docId = createHash('sha1').update(text).digest('hex').slice(0, 12)
    const dir = join(dataRoot(), 'docs', docId)
    await mkdir(dir, { recursive: true })
    if (file) await copyFile(file, join(dir, `original${ext}`))
    if (o.removeSource && file) await rm(file, { force: true })
    await writeFile(join(dir, 'raw.txt'), text)
    // 粘贴的文字没有文件名：标题留空，整理后用第一章的标题
    const title = file ? (o.name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() : (o.title || '')
    const meta = {
      docId, name: o.name || '粘贴的文字', title, type: r.type, ext, pages: r.pages || null,
      needsCleanup: !formatted, model: llm && llm.label ? llm.label() : '', hasModel: Boolean(llm),
      estimate: estimate(text, { needsCleanup: !formatted }), createdAt: Date.now(),
      preview: text.slice(0, 600),
    }
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 1))
    return meta
  }

  /** 导入文档第二步：用户确定后排队——AI 整理 → 存档 → 分课（每课再朗读、翻译） */
  async confirmDoc(docId, o = {}) {
    if (!/^[a-f0-9]{12}$/.test(String(docId))) throw Object.assign(new Error('文档编号不对'), { status: 400 })
    const dir = join(dataRoot(), 'docs', docId)
    let meta
    try { meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) } catch { throw Object.assign(new Error('找不到这份文档，重新选一次文件'), { status: 404 }) }
    meta.title = (o.title || meta.title || '').trim()
    meta.voice = { engine: o.engine, voice: o.voice, speed: o.speed }
    meta.confirmedAt = Date.now()
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 1))
    this.enqueue({ kind: 'docprep', docId, title: `整理文档：${meta.title || meta.name}` })
    return meta
  }

  /**
   * 导入英文文档：一章一课；每课排一个任务：朗读 → 翻译讲解 → 概述
   * @param {string} text 整理好的纯文本（# 章节标题 分章）
   * @param {{title?:string, engine?:'edge'|'kokoro', voice?:string, speed?:number}} o
   */
  async importDoc(text, o = {}) {
    const doc = parseDoc(text, { title: o.title || '' })
    const hash = createHash('sha1').update(text).digest('hex').slice(0, 6)
    const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'doc'
    const out = []
    for (const [k, c] of doc.chapters.entries()) {
      const id = `${slug(c.title)}-${hash}${doc.chapters.length > 1 ? `-${k + 1}` : ''}`.replace(/^-+/, '')
      const existing = await getLesson(id)
      if (existing && existing.status === 'ready') { out.push({ lessonId: id, existed: true, title: existing.title }); continue }
      const lesson = existing || {
        id, version: 1, kind: 'doc',
        title: c.title, group: doc.title || o.group || '文档', order: k,
        source: { type: 'doc', name: o.docName || doc.title, chars: text.length, ...(o.docId ? { docId: o.docId } : {}) },
        status: 'queued', createdAt: Date.now(),
        sentences: c.sentences.map((s, i) => ({ i, start: 0, end: 0, text: s.text, en: s.text, zh: '', words: [], sound: '', skip: false, para: s.para, ...(s.heading ? { heading: true } : {}) })),
      }
      if (!existing) await saveLesson(lesson)
      this.enqueue({ kind: 'doc', lessonId: id, title: lesson.title, engine: o.engine, voice: o.voice, speed: o.speed })
      out.push({ lessonId: id, existed: false, title: lesson.title, sentences: lesson.sentences.length })
    }
    return { title: doc.title, items: out }
  }

  /** 补全翻译（缺翻译的句子、缺概述） */
  async resume(lessonId) {
    const l = await getLesson(lessonId)
    if (!l) throw Object.assign(new Error('没有这节课'), { status: 404 })
    if (this.jobs.some(j => j.lessonId === lessonId && (j.state === 'queued' || j.state === 'running'))) return
    if (l.kind === 'doc' && !existsSync(audioPath(lessonId))) {
      this.enqueue({ kind: 'doc', lessonId, title: l.title, engine: l.engine, voice: l.voice, speed: l.speed })
    } else if (!l.sentences || !l.sentences.length) {
      const file = l.source && l.source.file
      if (!file || !existsSync(file)) throw Object.assign(new Error('原音频文件不在了，删掉这节课重新导入'), { status: 400 })
      this.enqueue({ kind: 'import', lessonId, title: l.title, file })
    } else {
      this.enqueue({ kind: 'translate', lessonId, title: l.title })
    }
  }

  /** 重新翻译整节课（换了更好的模型时用） */
  async retranslate(lessonId) {
    const l = await getLesson(lessonId)
    if (!l) throw Object.assign(new Error('没有这节课'), { status: 404 })
    for (const s of l.sentences || []) { s.zh = ''; s.en = ''; s.words = []; s.sound = ''; s.skip = false }
    l.summaryZh = ''; l.terms = []; l.titleZh = ''
    await saveLesson(l)
    this.enqueue({ kind: 'translate', lessonId, title: l.title })
  }

  /** 生成 / 重新生成一条声音轨 */
  async makeTrack(lessonId, track, extra = {}) {
    const l = await getLesson(lessonId)
    if (!l) throw Object.assign(new Error('没有这节课'), { status: 404 })
    if (!TRACKS[track] || TRACKS[track].kind === 'full') throw Object.assign(new Error('没有这种声音'), { status: 400 })
    if (!(l.sentences || []).length) throw Object.assign(new Error('这节课还没有句子'), { status: 400 })
    if (this.jobs.some(j => j.lessonId === lessonId && j.kind === 'track' && j.track === track && (j.state === 'queued' || j.state === 'running'))) return
    this.enqueue({ kind: 'track', lessonId, track, voice: extra.voice, speed: extra.speed, align: extra.align, engine: extra.engine, title: `${l.titleZh || l.title} · ${TRACKS[track].label}` })
  }

  /** 把几课发到 VPS（一个任务里依次发） */
  async sendToVps(ids) {
    const cfg = await getVpsConfig()
    if (!cfg) throw Object.assign(new Error('还没设置 VPS'), { status: 400 })
    if (this.jobs.some(j => j.kind === 'send' && (j.state === 'queued' || j.state === 'running'))) throw Object.assign(new Error('正在发送，等这一批发完'), { status: 400 })
    this.enqueue({ kind: 'send', ids, title: `发送 ${ids.length} 课到 VPS（${cfg.domain || cfg.host}）` })
  }

  cancel(jobId) {
    const j = this.jobs.find(x => x.id === jobId)
    if (!j) return false
    if (j.state === 'queued') { j.state = 'cancelled'; j.finishedAt = Date.now(); this.changed(); return true }
    if (j.state === 'running' && j.abort) { j.abort.abort(); return true }
    return false
  }

  enqueue(job) {
    Object.assign(job, { id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, state: 'queued', stage: '排队中', done: 0, total: 0 })
    this.jobs.push(job)
    // 只留最近 30 个
    if (this.jobs.length > 30) this.jobs = this.jobs.filter((j, k) => j.state === 'queued' || j.state === 'running' || k >= this.jobs.length - 30)
    this.changed()
    this.pump()
  }

  async pump() {
    if (this.running) return
    const job = this.jobs.find(j => j.state === 'queued')
    if (!job) return
    this.running = job
    job.state = 'running'
    job.startedAt = Date.now()
    job.abort = new AbortController()
    this.changed()
    try {
      await this.run(job)
      job.state = 'done'
    } catch (e) {
      const cancelled = job.abort.signal.aborted
      job.state = cancelled ? 'cancelled' : 'error'
      job.error = cancelled ? '' : e.message
      this.log(`[dsh-tingdong] ${job.title}：${e.message}`)
      try {
        const l = await getLesson(job.lessonId)
        if (l && l.status !== 'ready') {
          l.status = cancelled ? 'paused' : 'error'
          l.error = cancelled ? '' : e.message
          await saveLesson(l)
        }
      } catch { /* 忽略 */ }
    } finally {
      job.finishedAt = Date.now()
      job.abort = null
      this.running = null
      this.changed()
      setImmediate(() => this.pump())
    }
  }

  stage(job, stage, done = 0, total = 0, message = '') {
    Object.assign(job, { stage, done, total, message })
    this.changed()
  }

  async run(job) {
    const signal = job.abort.signal
    const opt = this.opts()
    if (job.kind === 'docprep') {
      const dir = join(dataRoot(), 'docs', job.docId)
      const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
      const raw = await readFile(join(dir, 'raw.txt'), 'utf8')
      let text = raw
      let warnings = []
      if (meta.needsCleanup) {
        const llm = this.deps.llm()
        if (llm) {
          this.stage(job, 'AI 整理文档', 0, Math.max(1, meta.estimate.chunks), '段')
          const r = await cleanupText(llm, raw, { title: meta.title, signal, concurrency: opt.concurrency || 3, onProgress: (d, t) => this.stage(job, 'AI 整理文档', d, t, '段') })
          text = r.text
          warnings = r.warnings
        } else {
          text = plainTidy(raw)
          warnings = ['没有可用的大模型：只简单接了断行，页眉页码可能还在']
        }
      }
      await writeFile(join(dir, 'clean.md'), text)
      const r = await this.importDoc(text, { title: meta.title, ...meta.voice, docId: job.docId, docName: meta.name })
      Object.assign(meta, { cleanedAt: Date.now(), warnings, lessons: r.items.map(x => x.lessonId) })
      await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 1))
      if (warnings.length) job.message = warnings[0]
      return
    }

    if (job.kind === 'doc') {
      if (!existsSync(audioPath(job.lessonId))) {
        const l = await getLesson(job.lessonId)
        l.status = 'transcribing'; l.error = ''
        await saveLesson(l)
        const r = await buildDocAudio(l, {
          ffmpeg: opt.ffmpeg, engine: job.engine, voice: job.voice, speed: job.speed, signal,
          onStage: (stage, done, total, unit) => this.stage(job, stage, done, total, unit),
        })
        const fresh = await getLesson(job.lessonId)
        for (const s of fresh.sentences) { const t = r.items[s.i]; if (t) { s.start = t[0]; s.end = t[1] } }
        Object.assign(fresh, { duration: r.duration, engine: r.engine, voice: r.voice, voiceLabel: r.voiceLabel, speed: r.speed, status: 'translating' })
        await saveLesson(fresh)
      }
      await this.translate(job, await getLesson(job.lessonId), signal)
      return
    }

    if (job.kind === 'send') {
      const cfg = await getVpsConfig()
      for (const [k, id] of job.ids.entries()) {
        const l0 = await getLesson(id)
        const name = l0 ? (l0.titleZh || l0.title) : id
        await sendLesson(cfg, id, {
          signal,
          onProgress: (sent, total) => this.stage(job, `第 ${k + 1}/${job.ids.length} 课：${name}`, Math.round(sent / 1048576), Math.round(total / 1048576), 'MB'),
        })
      }
      return
    }

    let l = await getLesson(job.lessonId)
    if (!l) throw new Error('课程不见了')

    if (job.kind === 'track') {
      await buildTrack(l, job.track, {
        ffmpeg: opt.ffmpeg, threads: opt.threads || 2, voice: job.voice, speed: job.speed, align: job.align, engine: job.engine, signal,
        onStage: (stage, done, total, unit) => this.stage(job, stage, done, total, unit),
      })
      return
    }

    if (job.kind === 'import' && !(l.sentences && l.sentences.length)) {
      this.stage(job, '准备识别模型')
      const models = await ensureModels({
        extraRoot: opt.modelDir, signal,
        onProgress: (name, got, all) => this.stage(job, `下载识别模型 ${name}`, Math.round(got / 1048576), Math.round(all / 1048576), 'MB'),
      })

      l.status = 'transcribing'; l.error = ''
      await saveLesson(l)
      this.stage(job, '识别英文')
      // 识别和压缩音频同时做
      const audioJob = compactAudio(job.file, audioPath(l.id) + '.part.mp3', { ffmpeg: opt.ffmpeg, signal })
      let duration = 0
      const asr = await transcribe(job.file, {
        models, ffmpeg: opt.ffmpeg, threads: opt.threads || 2, signal,
        onEvent: ev => {
          if (ev.type === 'duration') duration = ev.seconds
          if (ev.type === 'progress') this.stage(job, '识别英文', Math.round(ev.seconds), Math.round(duration), '秒')
        },
      })
      await audioJob
      await rename(audioPath(l.id) + '.part.mp3', audioPath(l.id))
      if (job.removeSource) await rm(job.file, { force: true })

      l = await getLesson(job.lessonId)
      l.duration = asr.duration
      l.sentences = mergeSegments(asr.segments).map((s, i) => ({ i, start: s.start, end: s.end, text: s.text, en: '', zh: '', words: [], sound: '', skip: false }))
      l.status = 'translating'
      await saveLesson(l)
      if (!l.sentences.length) {
        l.status = 'ready'; l.note = '没有识别到英文讲话'
        await saveLesson(l)
        return
      }
    }

    await this.translate(job, l, signal)

    // 新导入的课顺手做两条原声轨（只留讲话；再压背景），几秒钟的事
    if (job.kind === 'import') {
      l = await getLesson(job.lessonId)
      for (const name of ['clean', 'cleannr']) {
        try {
          await buildTrack(l, name, { ffmpeg: opt.ffmpeg, signal, onStage: (st, d, t, u) => this.stage(job, st, d, t, u) })
        } catch (e) {
          if (signal.aborted) throw e
          this.log(`[dsh-tingdong] ${TRACKS[name].label}失败：${e.message}`)
        }
      }
    }
  }

  async translate(job, l, signal) {
    const llm = this.deps.llm()
    if (!llm) {
      l.status = 'ready'
      l.note = '没有可用的大模型，只有英文。配置好模型后点「补全翻译」。'
      await saveLesson(l)
      return
    }
    l.status = 'translating'; l.error = ''; l.note = ''
    l.model = llm.label ? llm.label() : ''
    await saveLesson(l)
    const hint = [l.group, l.title].filter(Boolean).join(' · ')
    const total = l.sentences.filter(s => !s.zh && !s.skip).length
    this.stage(job, '翻译讲解', 0, total, '句')
    const res = await translateSentences(llm, l.sentences, {
      hint, signal, concurrency: this.opts().concurrency || 3, doc: l.kind === 'doc',
      onProgress: (d, t) => this.stage(job, '翻译讲解', d, t, '句'),
      onBatch: () => (signal.aborted ? null : saveLesson(l)),
    })
    await saveLesson(l)

    if (!l.summaryZh) {
      this.stage(job, '写全篇概述')
      // 模型偶尔吐出坏 JSON（中文里没转义的引号），再试一次
      for (let attempt = 0; attempt < 2 && !l.summaryZh; attempt++) {
        try {
          Object.assign(l, await summarizeLesson(llm, l.sentences, { hint, signal }))
        } catch (e) {
          if (signal.aborted) throw e
          this.log(`[dsh-tingdong] 概述失败（第 ${attempt + 1} 次）：${e.message}`)
        }
      }
    }
    l.status = 'ready'
    l.note = res.failed ? `有 ${res.failed} 句没翻译成功（${res.errors[0] || '未知原因'}），可以点「补全翻译」再试` : ''
    await saveLesson(l)
  }
}
