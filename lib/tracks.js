// lib/tracks.js — 一节课的几条「声音轨」：同样的句子，不同的声音，都去掉了空白、可以连续听
//
//   full     原声（完整，含音乐和空白）：lessons/<id>/audio.mp3，时间就是句子原本的时间
//   clean    原声·去空白：只留讲话，句间停 0.7 秒
//   cleannr  原声·压背景：同上，再滤掉低频双耳节拍和高频噪声
//   say      系统朗读：macOS 自带语音读校对后的英文
//   kokoro   Kokoro 朗读：离线神经网络语音
//   zh       中文对译：只有中文配音、没有背景音，每句放在对应英文的时间上（对齐原音频或「原声·去空白」）
//
// 每条（full 以外）存成 tracks/<name>.mp3 + tracks/<name>.json（{items:{i:[start,end]}, voice, speed, ...}）。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEncoder, RATE } from './pcm.js'
import { dataRoot, findFfmpeg, FFMPEG_HINT, lessonDir } from './paths.js'
import { ensureKokoro, ensureKokoroZh, sayVoices, zhVoice } from './voices.js'
import { edgeBin, edgeVoice } from './edge.js'

const WORKER = fileURLToPath(new URL('./tts-worker.js', import.meta.url))

export const TRACKS = {
  full: { label: '原声（完整）', kind: 'full' },
  clean: { label: '原声·去空白', kind: 'orig' },
  cleannr: { label: '原声·压背景', kind: 'orig', filter: 'highpass=f=180,lowpass=f=6500,afftdn=nf=-30' },
  say: { label: '系统朗读', kind: 'tts', engine: 'say' },
  kokoro: { label: 'Kokoro 朗读', kind: 'tts', engine: 'kokoro' },
  zh: { label: '中文对译', kind: 'zh', engine: 'kokoro-zh' },
}
export const TRACK_NAMES = Object.keys(TRACKS)

const tracksDir = id => join(lessonDir(id), 'tracks')
export const trackAudio = (id, name) => (name === 'full' ? join(lessonDir(id), 'audio.mp3') : join(tracksDir(id), `${name}.mp3`))
/** 无损版（目前只有中文配音有） */
export const trackFlac = (id, name) => join(tracksDir(id), `${name}.flac`)

/** 已生成的声音轨（不含 full） */
export async function listTracks(id) {
  const out = {}
  for (const name of TRACK_NAMES) {
    if (name === 'full') continue
    try {
      const meta = JSON.parse(await readFile(join(tracksDir(id), `${name}.json`), 'utf8'))
      if (existsSync(trackAudio(id, name))) out[name] = meta
    } catch { /* 没生成 */ }
  }
  return out
}

/**
 * 解码一个音频文件，按样本范围截出一段段（ranges 按 a 递增、互不重叠），每截完一段回调 onClip(i, samples)
 * @param {{i:number, a:number, b:number}[]} ranges 24 kHz 下的样本位置
 */
export async function extractClips(src, ranges, o) {
  const ffmpeg = findFfmpeg(o.ffmpeg)
  if (!ffmpeg) throw new Error(FFMPEG_HINT)
  if (!existsSync(src)) throw new Error('音频文件不在了')
  const args = ['-hide_banner', '-nostdin', '-i', src, '-vn', '-ac', '1', '-ar', String(RATE)]
  if (o.filter) args.push('-af', o.filter)
  args.push('-f', 'f32le', 'pipe:1')
  const dec = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  const onAbort = () => dec.kill('SIGKILL')
  if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true })
  let k = 0 // 当前段
  let buf = null // 当前段已收的样本
  let got = 0
  let pos = 0 // 已解码的样本数
  let carry = Buffer.alloc(0)
  try {
    for await (const chunk of dec.stdout) {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const usable = data.length - (data.length % 4)
      carry = data.subarray(usable)
      const f = new Float32Array(usable / 4)
      new Uint8Array(f.buffer).set(data.subarray(0, usable))
      const end = pos + f.length
      while (k < ranges.length) {
        const r = ranges[k]
        if (r.a >= end) break
        if (!buf) { buf = new Float32Array(r.b - r.a); got = 0 }
        // 这一块里落在本段范围内的样本
        const s0 = Math.max(r.a, pos)
        const s1 = Math.min(r.b, end)
        if (s1 > s0) {
          buf.set(f.subarray(s0 - pos, s1 - pos), s0 - r.a)
          got = s1 - r.a
        }
        if (r.b > end) break // 本段还没收完，等下一块
        await o.onClip(r.i, buf)
        buf = null
        k++
      }
      pos = end
      if (k >= ranges.length) { dec.kill('SIGKILL'); break }
    }
    if (o.signal && o.signal.aborted) throw new Error('已取消')
    // 音频比最后一段的结尾短：收尾
    if (buf && k < ranges.length) { await o.onClip(ranges[k].i, buf.subarray(0, got)); k++ }
  } finally {
    if (o.signal) o.signal.removeEventListener('abort', onAbort)
  }
}

/** 原声类：按句截取（前 0.12 秒、后 0.3 秒，不越过相邻句子的中点），句间固定停顿 */
async function buildOrig(lesson, name, o) {
  const def = TRACKS[name]
  const ffmpeg = findFfmpeg(o.ffmpeg)
  if (!ffmpeg) throw new Error(FFMPEG_HINT)
  const src = trackAudio(lesson.id, 'full')
  if (!existsSync(src)) throw new Error('这节课还没有音频')
  const list = lesson.sentences.filter(s => !s.skip).sort((a, b) => a.start - b.start)
  const ranges = paddedRanges(list)
  const out = join(tracksDir(lesson.id), `${name}.part.mp3`)
  const enc = createEncoder({ ffmpeg, out, gap: o.gap, signal: o.signal })
  let n = 0
  try {
    await extractClips(src, ranges, {
      ffmpeg, filter: def.filter, signal: o.signal,
      onClip: async (i, samples) => { await enc.write(i, samples); n++; if (o.onProgress) o.onProgress(n, ranges.length) },
    })
    const res = await enc.finish()
    await rename(out, trackAudio(lesson.id, name))
    return res
  } catch (e) {
    enc.abort()
    await rm(out, { force: true })
    throw e
  }
}

/** 原音频里每句的截取范围（样本） */
export function paddedRanges(list) {
  return list.map((s, k) => {
    const prev = list[k - 1]
    const next = list[k + 1]
    const a = Math.max(s.start - 0.12, prev ? (prev.end + s.start) / 2 : 0)
    const b = Math.min(s.end + 0.3, next ? (s.end + next.start) / 2 : Infinity)
    return { i: s.i, a: Math.round(a * RATE), b: Math.round(b * RATE) }
  })
}

/** 跑朗读子进程，转发进度；失败时删掉半成品 */
function runWorker(args, o, stage) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    let result = null
    let failure = null
    let stderr = ''
    let line = ''
    const onAbort = () => child.kill('SIGKILL')
    if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', d => {
      line += d
      let nl
      while ((nl = line.indexOf('\n')) >= 0) {
        let ev
        try { ev = JSON.parse(line.slice(0, nl)) } catch { ev = null }
        line = line.slice(nl + 1)
        if (!ev) continue
        if (ev.type === 'progress' && o.onStage) o.onStage(stage, ev.done, ev.total, '句')
        if (ev.type === 'done') result = ev
        if (ev.type === 'error') failure = ev.message
      }
    })
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-3000) })
    child.on('error', reject)
    child.on('close', code => {
      if (o.signal) o.signal.removeEventListener('abort', onAbort)
      if (o.signal && o.signal.aborted) return reject(new Error('已取消'))
      if (code !== 0 || !result) return reject(new Error(failure || `朗读进程退出（${code}）：${stderr.trim().split('\n').slice(-2).join(' ')}`))
      resolve(result)
    })
  }).catch(async e => { await rm(args.out, { force: true }); throw e })
}

/**
 * 中文对译：每句中文放在对应英文开始的时刻，其余是静音
 * align = 'full'：对齐原音频（总长一样）；'clean'：对齐「原声·去空白」
 * 每句可用的时间到下一句英文开始为止；读不完的那句读快一点（最快 1.6 倍）
 */
async function buildZh(lesson, o) {
  const ffmpeg = findFfmpeg(o.ffmpeg)
  if (!ffmpeg) throw new Error(FFMPEG_HINT)
  const engine = o.engine === 'edge' ? 'edge' : 'kokoro'
  const voice = engine === 'edge' ? edgeVoice(o.voice) : zhVoice(o.voice)
  if (engine === 'edge' && !edgeBin()) throw Object.assign(new Error('还没装 Edge 语音组件：在「导出 → 中文配音」里点「安装 Edge 语音组件」'), { status: 400 })
  const align = o.align === 'clean' ? 'clean' : 'full'
  const talk = lesson.sentences.filter(s => !s.skip).sort((a, b) => a.start - b.start)
  let at
  let total
  if (align === 'clean') {
    const clean = (await listTracks(lesson.id)).clean
    if (!clean) throw Object.assign(new Error('还没有「原声·去空白」，先生成它，或者选对齐原音频'), { status: 400 })
    at = s => (clean.items[s.i] ? clean.items[s.i][0] : null)
    total = clean.duration
  } else {
    at = s => s.start
    total = lesson.duration
  }
  const placed = talk.map(s => ({ s, start: at(s) })).filter(x => x.start !== null).sort((a, b) => a.start - b.start)
  const sentences = placed
    .map((x, k) => ({ i: x.s.i, text: x.s.zh || '', start: x.start, slot: Math.max(0.6, ((placed[k + 1] ? placed[k + 1].start : total) - x.start) - 0.25) }))
    .filter(x => x.text.trim())
  if (!sentences.length) throw Object.assign(new Error('这一课还没有中文翻译'), { status: 400 })
  const kokoroDir = engine === 'kokoro'
    ? await ensureKokoroZh({ signal: o.signal, onProgress: (g, t) => o.onStage && o.onStage('下载中文语音模型', Math.round(g / 1048576), Math.round(t / 1048576), 'MB') })
    : undefined
  const out = join(tracksDir(lesson.id), 'zh.part.mp3')
  const flac = join(tracksDir(lesson.id), 'zh.part.flac')
  const args = { flac, engine: `${engine}-zh`, sid: voice.sid, voice: voice.id, speed: o.speed || 1, sentences, total, kokoroDir, ffmpeg, out, threads: o.threads || 2, bitrate: '48k' }
  o.onStage && o.onStage(`中文对译（${voice.label}）`, 0, sentences.length, '句')
  let res
  try { res = await runWorker(args, o, `中文对译（${voice.label}）`) } catch (e) { await rm(flac, { force: true }); throw e }
  await rename(out, trackAudio(lesson.id, 'zh'))
  await rename(flac, trackFlac(lesson.id, 'zh'))
  return { flac: true, items: res.items, duration: res.duration, engine, voice: voice.id, voiceLabel: `${engine === 'edge' ? 'Edge ' : ''}${voice.label}`, speed: args.speed, align, squeezed: res.squeezed || 0 }
}

/** 试听一个中文音色：同一句话，生成一次缓存起来 */
const ZH_SAMPLE = '现在进入你的准备流程。首先，用你的能量转换盒，接着做共振调音。'
export async function zhSample(voiceId, o = {}) {
  const engine = o.engine === 'edge' ? 'edge' : 'kokoro'
  const voice = engine === 'edge' ? edgeVoice(voiceId) : zhVoice(voiceId)
  const ffmpeg = findFfmpeg(o.ffmpeg)
  if (!ffmpeg) throw new Error(FFMPEG_HINT)
  if (engine === 'edge' && !edgeBin()) throw Object.assign(new Error('还没装 Edge 语音组件'), { status: 400 })
  const dir = join(dataRoot(), 'samples')
  const file = join(dir, `zh-${engine}-${voice.id}.mp3`)
  if (existsSync(file)) return file
  await mkdir(dir, { recursive: true })
  const kokoroDir = engine === 'kokoro' ? await ensureKokoroZh({ signal: o.signal }) : undefined
  const out = join(dir, `zh-${engine}-${voice.id}.part.mp3`)
  await runWorker({ engine: `${engine}-zh`, sid: voice.sid, voice: voice.id, speed: 1, sentences: [{ i: 0, text: ZH_SAMPLE, start: 0 }], total: 0, kokoroDir, ffmpeg, out, threads: 2, bitrate: '64k' }, o, '试听')
  await rename(out, file)
  return file
}

/** 朗读类：交给子进程 */
async function buildTts(lesson, name, o) {
  const def = TRACKS[name]
  const ffmpeg = findFfmpeg(o.ffmpeg)
  if (!ffmpeg) throw new Error(FFMPEG_HINT)
  let voice = o.voice
  let kokoroDir
  if (def.engine === 'kokoro') {
    kokoroDir = await ensureKokoro({ signal: o.signal, onProgress: (g, t) => o.onStage && o.onStage('下载 Kokoro 语音模型', Math.round(g / 1048576), Math.round(t / 1048576), 'MB') })
    voice = voice || 'am_michael'
  } else {
    if (process.platform !== 'darwin') throw new Error('系统朗读只支持 macOS')
    const voices = await sayVoices()
    if (!voice || !voices.some(v => v.id === voice)) voice = voices[0] ? voices[0].id : 'Samantha'
  }
  const sentences = lesson.sentences.filter(s => !s.skip).sort((a, b) => a.start - b.start).map(s => ({ i: s.i, text: s.en || s.text }))
  const out = join(tracksDir(lesson.id), `${name}.part.mp3`)
  const args = { engine: def.engine, voice, speed: o.speed || 0.9, sentences, kokoroDir, ffmpeg, out, gap: o.gap ?? 0.7, threads: o.threads || 2 }
  o.onStage && o.onStage(`${def.label}（${voice}）`, 0, sentences.length, '句')
  const res = await runWorker(args, o, `${def.label}（${voice}）`)
  await rename(out, trackAudio(lesson.id, name))
  return { items: res.items, duration: res.duration, voice, speed: args.speed }
}

/**
 * 生成一条声音轨（覆盖旧的）
 * @param {object} lesson 整节课
 * @param {string} name clean | cleannr | say | kokoro | zh
 * @param {object} o { ffmpeg?, voice?, speed?, gap?, align?（中文对译）, threads?, signal?, onStage?(stage,done,total,unit), onProgress? }
 */
export async function buildTrack(lesson, name, o = {}) {
  const def = TRACKS[name]
  if (!def || def.kind === 'full') throw Object.assign(new Error('没有这种声音'), { status: 400 })
  await mkdir(tracksDir(lesson.id), { recursive: true })
  const res = def.kind === 'orig'
    ? await buildOrig(lesson, name, { ...o, onProgress: (d, t) => o.onStage && o.onStage(def.label, d, t, '句') })
    : def.kind === 'zh' ? await buildZh(lesson, o) : await buildTts(lesson, name, o)
  const meta = { name, label: def.label, createdAt: Date.now(), gap: o.gap ?? 0.7, ...res }
  await writeFile(join(tracksDir(lesson.id), `${name}.json`), JSON.stringify(meta))
  return meta
}
