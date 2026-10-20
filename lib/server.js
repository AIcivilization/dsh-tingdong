// lib/server.js — 学习面板用的 HTTP 接口；DSH 插件（挂在 dsh 的 webServer 上）和独立运行（dsh-tingdong serve）共用
//
//   GET  <prefix>/panel  /panel.js  /panel.css   面板
//   GET  <prefix>/status                         ffmpeg / 识别模型 / 大模型是否就绪
//   GET  <prefix>/lessons                        课程列表（带进度）
//   GET  <prefix>/lesson?id=                     一节课（句子 + 进度）
//   GET  <prefix>/audio?id=&track=&download=1    音频（支持 Range）；track 见 lib/tracks.js，download=1 存成 MP3
//   GET  <prefix>/voices                         能用的朗读声音（系统语音、Kokoro）
//   GET  <prefix>/jobs                           导入任务
//   POST <prefix>/import   {path, title?}        导入本机的文件或文件夹
//   POST <prefix>/upload?name=                   上传音频（请求体就是文件）
//   POST <prefix>/grade    {id, i, g}            给一句评分（0 没懂 / 1 半懂 / 2 懂了）
//   POST <prefix>/resume | retranslate | reset | delete  {id}
//   POST <prefix>/track    {id, track, voice?, speed?}  生成 / 重新生成一条声音轨
//   POST <prefix>/cancel   {job}
//   GET  <prefix>/today?tz=                      今天要学的：所有课里到期的句子 + 新句子，连续天数、今天学了多少
//   POST <prefix>/state    {id, pos?, track?}    学到第几句、选的声音（存服务器，换设备接着学）
//   POST <prefix>/star     {id, i, on}           收藏难句
//   POST <prefix>/edit     {id, i, en?, zh?, skip?} | /merge {id, i} | /split {id, i, at}   改句子
//   POST <prefix>/explain  {id, ids}             重新讲解几句（用大模型）
//   POST <prefix>/lookup   {id, i, word}         点词查意思
//   POST <prefix>/drill    {id, track, repeat, pause, scope, from}   生成「磨耳朵」音频
//   GET  <prefix>/vps | POST /vps/detect {host} | /vps/config {...} | /vps/send {ids}  发送到 VPS
//   GET  <prefix>/export?id=&format=&align=     导出文字：字幕 SRT、歌词 LRC、录音稿、表格
//   POST <prefix>/voice-sample {engine, voice}   试听一个中文音色 · POST /edge/install 装 / 更新 Edge 语音组件
//
// 会改东西的请求都要带 x-tingdong 头：别的网站发跨站请求带不了自定义头（要预检），挡住 CSRF。

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { findModels } from './models.js'
import { findFfmpeg, uploadsDir } from './paths.js'
import { AUDIO_EXT } from './importer.js'
import { listTracks, trackAudio, TRACKS, zhSample } from './tracks.js'
import { buildDrill, DRILL_RE } from './drill.js'
import { explainSentences, lookupWord } from './lookup.js'
import { today } from './today.js'
import { exportText, FORMATS } from './export.js'
import { EDGE_ZH_VOICES, edgeStatus, installEdge } from './edge.js'
import { detect, getVpsConfig, panelUrl, saveVpsConfig, sshHosts } from './vps.js'
import { KOKORO_VOICES, kokoroReady, kokoroZhReady, SAY_HINT, sayVoices, ZH_VOICES } from './voices.js'
import { checkId, deleteLesson, editSentence, getLesson, getProgress, gradeSentence, listLessons, mergeWithNext, resetProgress, setProgressFields, setStar, splitSentence, summary } from './store.js'

const STATIC = {
  '/panel': ['web/panel.html', 'text/html; charset=utf-8'],
  '/panel.css': ['web/panel.css', 'text/css; charset=utf-8'],
  '/srs.js': ['lib/srs.js', 'text/javascript; charset=utf-8'],
}
// 面板的 JS 模块：web/ 下固定的几个文件
for (const name of ['panel', 'core', 'study', 'listen', 'edit', 'dict']) STATIC[`/${name}.js`] = [`web/${name}.js`, 'text/javascript; charset=utf-8']

const MAX_UPLOAD = 2 * 1024 * 1024 * 1024

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', c => { size += c.length; if (size > limit) { req.destroy(); resolve({}) } else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function safePost(req) {
  if (req.method !== 'POST' || !req.headers['x-tingdong']) return false
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

async function serveAudio(req, res, file, filename) {
  let st
  try { st = await stat(file) } catch { return send(res, 404, { error: '这条声音还没有生成' }) }
  const size = st.size
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''))
  // 重新生成后文件会变：用修改时间做 ETag，别让浏览器拿旧的缓存配新的时间表
  const head = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'private, no-cache', etag: `"${st.size}-${Math.round(st.mtimeMs)}"` }
  if (filename) head['content-disposition'] = `attachment; filename="audio.mp3"; filename*=UTF-8''${encodeURIComponent(filename)}`
  if (!m || (!m[1] && !m[2])) {
    res.writeHead(200, { ...head, 'content-length': size })
    if (req.method === 'HEAD') return res.end()
    return createReadStream(file).pipe(res)
  }
  let start = m[1] ? Number(m[1]) : size - Number(m[2])
  let end = m[1] && m[2] ? Number(m[2]) : size - 1
  start = Math.max(0, start); end = Math.min(size - 1, end)
  if (start > end) {
    res.writeHead(416, { 'content-range': `bytes */${size}` })
    return res.end()
  }
  res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file, { start, end }).pipe(res)
}

/**
 * @param {object} o
 * @param {string} o.prefix 例如 /api-dsh-tingdong
 * @param {string} o.pkgRoot 包根目录（找 web/）
 * @param {import('./importer.js').Importer} o.importer
 * @param {() => object} [o.status] 额外的状态字段（插件版本、当前模型……）
 * @param {() => object} [o.options] { ffmpeg?, modelDir? }
 */
export function createHandler(o) {
  const opts = () => (o.options && o.options()) || {}
  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://x')
    const path = url.pathname.slice(o.prefix.length) || '/'
    const q = url.searchParams
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (STATIC[path]) {
          const [rel, type] = STATIC[path]
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
          return res.end(await readFile(join(o.pkgRoot, rel)))
        }
        if (path === '/status') {
          const models = await findModels(opts().modelDir)
          return send(res, 200, {
            ffmpeg: Boolean(findFfmpeg(opts().ffmpeg)),
            models: Boolean(models),
            ...(o.status ? await o.status() : {}),
          })
        }
        if (path === '/lessons') return send(res, 200, { lessons: await listLessons() })
        if (path === '/lesson') {
          const id = checkId(q.get('id'))
          const l = await getLesson(id)
          if (!l) return send(res, 404, { error: '没有这节课' })
          const p = await getProgress(id)
          const tracks = await listTracks(id)
          return send(res, 200, { lesson: l, progress: p, summary: summary(l, p), tracks, trackDefs: TRACKS, now: Date.now() })
        }
        if (path === '/audio') {
          const id = checkId(q.get('id'))
          const track = q.get('track') || 'full'
          if (!TRACKS[track] && !DRILL_RE.test(track)) return send(res, 400, { error: '没有这种声音' })
          let filename = ''
          if (q.get('download')) {
            const l = await getLesson(id)
            const meta = TRACKS[track] ? (await listTracks(id))[track] : null
            const label = TRACKS[track] ? TRACKS[track].label + (meta && meta.voiceLabel ? `（${meta.voiceLabel}）` : '') : '磨耳朵'
            filename = `${(l && (l.titleZh || l.title)) || id} - ${label}.mp3`.replace(/[\\/:*?"<>|]/g, '_')
          }
          return serveAudio(req, res, trackAudio(id, track), filename)
        }
        if (path === '/voices') {
          return send(res, 200, {
            say: await sayVoices(), sayHint: SAY_HINT,
            kokoro: { ready: await kokoroReady(), voices: KOKORO_VOICES },
            zh: { ready: await kokoroZhReady(), voices: ZH_VOICES.map(({ id, label, gender }) => ({ id, label, gender })) },
            edge: { ...(await edgeStatus()), voices: EDGE_ZH_VOICES },
          })
        }
        if (path === '/export') {
          const id = checkId(q.get('id'))
          const l = await getLesson(id)
          if (!l) return send(res, 404, { error: '没有这节课' })
          const format = q.get('format') || 'srt-bi'
          const align = q.get('align') === 'clean' ? 'clean' : 'full'
          const out = await exportText(l, format, align)
          const name = `${l.titleZh || l.title} - ${out.label.split(/[ （]/)[0]}${align === 'clean' ? '（去空白）' : ''}.${out.ext}`.replace(/[\\/:*?"<>|]/g, '_')
          res.writeHead(200, {
            'content-type': `${out.ext === 'csv' ? 'text/csv' : 'text/plain'}; charset=utf-8`,
            'content-disposition': `attachment; filename="export.${out.ext}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            'cache-control': 'no-store',
          })
          return res.end(out.text)
        }
        if (path === '/formats') return send(res, 200, { formats: FORMATS })
        if (path === '/jobs') return send(res, 200, { jobs: o.importer.list() })
        if (path === '/today') return send(res, 200, await today({ tz: Number(q.get('tz')) || 0 }))
        if (path === '/vps') {
          // 发送到 VPS 只在做课的电脑上有意义：VPS 自己那份不显示这一块
          const cfg = await getVpsConfig()
          return send(res, 200, { enabled: o.vps !== false, config: cfg, url: panelUrl(cfg), hosts: o.vps === false ? [] : await sshHosts() })
        }
        return send(res, 404, { error: 'not found' })
      }

      if (!safePost(req)) return send(res, 403, { error: '只接受本页面发出的请求' })

      if (path === '/upload') {
        const name = String(q.get('name') || 'audio.mp3').replace(/[\\/]/g, '_').slice(0, 200)
        const ext = extname(name).toLowerCase()
        if (!AUDIO_EXT.includes(ext)) return send(res, 400, { error: '不是音频文件（支持 mp3、m4a、wav、flac 等）' })
        if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) return send(res, 413, { error: '文件太大（最多 2 GB）' })
        await mkdir(uploadsDir(), { recursive: true })
        const tmp = join(uploadsDir(), `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
        try {
          await pipeline(req, createWriteStream(tmp))
        } catch (e) {
          await rm(tmp, { force: true })
          throw e
        }
        const items = await o.importer.importPath(tmp, { removeSource: true, displayName: name, title: q.get('title') || '' })
        return send(res, 200, { ok: true, items })
      }

      const body = await readJson(req)
      if (path === '/import') {
        if (typeof body.path !== 'string' || !body.path.trim()) return send(res, 400, { error: '请填音频文件或文件夹的路径' })
        const items = await o.importer.importPath(body.path, { title: typeof body.title === 'string' ? body.title.trim() : '' })
        return send(res, 200, { ok: true, items })
      }
      if (path === '/grade') {
        const id = checkId(body.id)
        const g = Number(body.g)
        if (![0, 1, 2].includes(g) || !Number.isInteger(Number(body.i))) return send(res, 400, { error: '参数不对' })
        return send(res, 200, { ok: true, card: await gradeSentence(id, Number(body.i), g), now: Date.now() })
      }
      if (path === '/resume') { await o.importer.resume(checkId(body.id)); return send(res, 200, { ok: true }) }
      if (path === '/retranslate') { await o.importer.retranslate(checkId(body.id)); return send(res, 200, { ok: true }) }
      if (path === '/reset') { await resetProgress(checkId(body.id)); return send(res, 200, { ok: true }) }
      if (path === '/delete') {
        const id = checkId(body.id)
        for (const j of o.importer.jobs) if (j.lessonId === id) o.importer.cancel(j.id)
        await deleteLesson(id)
        return send(res, 200, { ok: true })
      }
      if (path === '/track') {
        const speed = Number(body.speed)
        await o.importer.makeTrack(checkId(body.id), String(body.track || ''), {
          voice: typeof body.voice === 'string' && body.voice.length < 80 ? body.voice : undefined,
          speed: Number.isFinite(speed) && speed >= 0.5 && speed <= 1.5 ? speed : undefined,
          align: body.align === 'clean' ? 'clean' : 'full',
          engine: body.engine === 'edge' ? 'edge' : 'kokoro',
        })
        return send(res, 200, { ok: true })
      }
      const llm = () => (o.importer.deps && o.importer.deps.llm ? o.importer.deps.llm() : null)
      if (path === '/state') {
        return send(res, 200, { ok: true, ...(await setProgressFields(checkId(body.id), { pos: Number.isInteger(body.pos) ? body.pos : undefined, track: body.track })) })
      }
      if (path === '/star') return send(res, 200, { ok: true, stars: await setStar(checkId(body.id), Number(body.i), Boolean(body.on)) })
      if (path === '/edit') return send(res, 200, { ok: true, sentence: await editSentence(checkId(body.id), Number(body.i), body) })
      if (path === '/merge') return send(res, 200, { ok: true, sentence: await mergeWithNext(checkId(body.id), Number(body.i)) })
      if (path === '/split') return send(res, 200, { ok: true, sentences: await splitSentence(checkId(body.id), Number(body.i), Number(body.at)) })
      if (path === '/explain') {
        const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isInteger).slice(0, 10)
        return send(res, 200, { ok: true, sentences: await explainSentences(llm(), checkId(body.id), ids) })
      }
      if (path === '/lookup') {
        return send(res, 200, { ok: true, ...(await lookupWord(llm(), checkId(body.id), Number(body.i), String(body.word || '').slice(0, 80))) })
      }
      if (path === '/drill') {
        const id = checkId(body.id)
        const l = await getLesson(id)
        if (!l) return send(res, 404, { error: '没有这节课' })
        const out = await buildDrill(l, await getProgress(id), {
          track: String(body.track || ''), repeat: body.repeat, pause: body.pause, scope: String(body.scope || 'all'), from: body.from,
          ffmpeg: opts().ffmpeg,
        })
        return send(res, 200, { ok: true, ...out })
      }
      if (path === '/voice-sample') {
        // 试听中文音色（第一次会先下载中文语音模型）
        const file = await zhSample(String(body.voice || ''), { ffmpeg: opts().ffmpeg, engine: body.engine === 'edge' ? 'edge' : 'kokoro' })
        return serveAudio(req, res, file)
      }
      if (path === '/edge/install') return send(res, 200, { ok: true, ...(await installEdge()) })
      if (path === '/vps/detect') return send(res, 200, { ok: true, ...(await detect(String(body.host || ''))) })
      if (path === '/vps/config') {
        const cfg = await saveVpsConfig(body)
        return send(res, 200, { ok: true, config: cfg, url: panelUrl(cfg) })
      }
      if (path === '/vps/send') {
        const all = (await listLessons()).filter(l => l.status === 'ready' && l.hasAudio).map(l => l.id)
        const ids = body.ids === 'all' ? all : (Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => all.includes(x))
        if (!ids.length) return send(res, 400, { error: '没有可以发送的课（要已经做好的课）' })
        await o.importer.sendToVps(ids)
        return send(res, 200, { ok: true, count: ids.length })
      }
      if (path === '/cancel') return send(res, 200, { ok: o.importer.cancel(String(body.job || '')) })
      return send(res, 404, { error: 'not found' })
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message || String(e) })
      else res.destroy()
    }
  }
}
