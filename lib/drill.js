// lib/drill.js — 「磨耳朵」：把一课（或其中的难句、收藏、待复习）做成一段可以闭着眼听的音频
//
// 每句：放 repeat 遍（遍与遍之间停 0.8 秒）→ 停 pause 秒让你在心里说出意思 → 下一句。
// 做成真正的 MP3 而不是在网页里用定时器控制：手机锁屏后网页的定时器会被大幅推迟，
// 一段普通音频则能一直放下去，锁屏界面、耳机线控也都能用；界面按时间表同步显示字幕。

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createEncoder, RATE } from './pcm.js'
import { findFfmpeg, FFMPEG_HINT, lessonDir } from './paths.js'
import { extractClips, listTracks, paddedRanges, trackAudio } from './tracks.js'

export const DRILL_RE = /^drill-[a-f0-9]{12}$/
export const SCOPES = { all: '全部', hard: '难句', star: '收藏', due: '待复习' }
const REP_GAP = 0.8
const MAX_SENTENCES = 300

/** 按范围挑句子（原文顺序） */
export function pickSentences(lesson, progress, { scope = 'all', from = 0, now = Date.now() } = {}) {
  const cards = (progress && progress.cards) || {}
  const stars = new Set((progress && progress.stars) || [])
  const list = lesson.sentences.filter(s => !s.skip).sort((a, b) => a.start - b.start)
  if (scope === 'hard') return list.filter(s => { const c = cards[s.i]; return c && (c.again > 0 || c.lastGrade < 2) })
  if (scope === 'star') return list.filter(s => stars.has(s.i))
  if (scope === 'due') return list.filter(s => cards[s.i] && cards[s.i].due <= now)
  return list.slice(Math.max(0, Math.min(Number(from) || 0, list.length - 1)))
}

/**
 * @param {object} lesson
 * @param {object} progress
 * @param {{track?:string, repeat?:number, pause?:number, scope?:string, from?:number, ffmpeg?:string, signal?:AbortSignal}} o
 * @returns {Promise<{name:string, duration:number, items:{i:number, reps:number[][], think:number[]}[], cached:boolean}>}
 */
export async function buildDrill(lesson, progress, o = {}) {
  const ffmpeg = findFfmpeg(o.ffmpeg)
  if (!ffmpeg) throw Object.assign(new Error(FFMPEG_HINT), { status: 500 })
  const repeat = Math.min(4, Math.max(1, Math.round(Number(o.repeat) || 2)))
  const pause = Math.min(10, Math.max(0, Number(o.pause ?? 3)))
  const scope = SCOPES[o.scope] ? o.scope : 'all'
  const list = pickSentences(lesson, progress, { scope, from: o.from }).slice(0, MAX_SENTENCES)
  if (!list.length) throw Object.assign(new Error(`没有「${SCOPES[scope]}」的句子`), { status: 400 })

  // 从哪条声音里截：完整原声按句子时间加余量；其他声音按它们自己的时间表
  let track = o.track || 'clean'
  const tracks = await listTracks(lesson.id)
  if (track !== 'full' && !tracks[track]) track = tracks.clean ? 'clean' : 'full'
  const src = trackAudio(lesson.id, track)
  const ranges = track === 'full'
    ? paddedRanges(list)
    : list.filter(s => tracks[track].items[s.i]).map(s => {
      const [a, b] = tracks[track].items[s.i]
      return { i: s.i, a: Math.round(a * RATE), b: Math.round(b * RATE) }
    }).sort((x, y) => x.a - y.a)
  if (!ranges.length) throw Object.assign(new Error('这条声音里没有这些句子，换一种声音或重新生成'), { status: 400 })

  const stamp = track === 'full' ? (await stat(src)).mtimeMs : tracks[track].createdAt
  const key = createHash('sha1').update(JSON.stringify([track, stamp, repeat, pause, ranges.map(r => r.i)])).digest('hex').slice(0, 12)
  const name = `drill-${key}`
  const dir = join(lessonDir(lesson.id), 'tracks')
  const meta = join(dir, `${name}.json`)
  if (existsSync(meta) && existsSync(join(dir, `${name}.mp3`))) {
    return { ...JSON.parse(await readFile(meta, 'utf8')), cached: true }
  }

  await mkdir(dir, { recursive: true })
  const part = join(dir, `${name}.part.mp3`)
  const enc = createEncoder({ ffmpeg, out: part, gap: 0, signal: o.signal })
  const items = []
  try {
    await extractClips(src, ranges, {
      ffmpeg, signal: o.signal,
      onClip: async (i, samples) => {
        const reps = []
        for (let r = 0; r < repeat; r++) {
          if (r) await enc.pad(REP_GAP)
          reps.push(await enc.write(null, samples))
        }
        const t0 = enc.seconds
        await enc.pad(pause + 0.4)
        items.push({ i, reps, think: [round(t0), round(enc.seconds)] })
      },
    })
    const res = await enc.finish()
    await rename(part, join(dir, `${name}.mp3`))
    const out = { name, track, repeat, pause, scope, duration: res.duration, items, createdAt: Date.now() }
    await writeFile(meta, JSON.stringify(out))
    await prune(dir, name)
    return { ...out, cached: false }
  } catch (e) {
    enc.abort()
    await rm(part, { force: true })
    throw e
  }
}

/** 只留最近 4 段磨耳朵音频 */
async function prune(dir, keep) {
  const files = (await readdir(dir)).filter(f => /^drill-[a-f0-9]{12}\.json$/.test(f))
  const withTime = await Promise.all(files.map(async f => ({ f, t: (await stat(join(dir, f))).mtimeMs })))
  withTime.sort((a, b) => b.t - a.t)
  for (const { f } of withTime.slice(4)) {
    const base = f.replace(/\.json$/, '')
    if (base === keep) continue
    await rm(join(dir, f), { force: true })
    await rm(join(dir, `${base}.mp3`), { force: true })
  }
}

const round = n => Math.round(n * 1000) / 1000
