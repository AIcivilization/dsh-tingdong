// lib/asr.js — 在子进程里识别一个音频文件，返回带时间的句子；顺手做压缩音频
//
// 识别结果先按 VAD 切出来的片段给，再用 mergeSegments() 拼成适合练听力的句子：
// 太碎的（"First." "Next."）和后一句接上，太长的不拼。

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findFfmpeg, FFMPEG_HINT } from './paths.js'

const WORKER = fileURLToPath(new URL('./asr-worker.js', import.meta.url))

/**
 * @param {string} file 音频文件（mp3 / m4a / wav / flac……ffmpeg 能读的都行）
 * @param {object} opt { models, ffmpeg?, threads?, language?, signal?, onEvent? }
 * @returns {Promise<{duration:number, segments:{start:number,end:number,text:string}[]}>}
 */
export function transcribe(file, opt) {
  const ffmpeg = findFfmpeg(opt.ffmpeg)
  if (!ffmpeg) return Promise.reject(new Error(FFMPEG_HINT))
  const args = {
    file, ffmpeg, models: opt.models, language: opt.language || 'en', threads: opt.threads || 2,
    vadThreshold: opt.vadThreshold, minSilenceSeconds: opt.minSilenceSeconds, maxSpeechSeconds: opt.maxSpeechSeconds,
  }
  return new Promise((resolve, reject) => {
    // Electron 里 process.execPath 是 App 本体：ELECTRON_RUN_AS_NODE=1 让它当 Node 用
    const child = spawn(process.execPath, [WORKER, JSON.stringify(args)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    const segments = []
    let duration = 0
    let failure = null
    let buf = ''
    let stderr = ''
    const onAbort = () => child.kill('SIGKILL')
    if (opt.signal) {
      if (opt.signal.aborted) onAbort()
      else opt.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', d => {
      buf += d.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        if (ev.type === 'segment') segments.push({ start: round(ev.start), end: round(ev.end), text: ev.text })
        else if (ev.type === 'duration') duration = ev.seconds
        else if (ev.type === 'error') failure = ev.message
        if (opt.onEvent) { try { opt.onEvent(ev) } catch { /* 进度回调出错不影响识别 */ } }
      }
    })
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000) })
    child.on('error', reject)
    child.on('close', code => {
      if (opt.signal) opt.signal.removeEventListener('abort', onAbort)
      if (opt.signal && opt.signal.aborted) return reject(new Error('已取消'))
      if (code !== 0 || failure) return reject(new Error(failure || `识别进程退出（${code}）：${stderr.trim().split('\n').slice(-3).join(' ')}`))
      resolve({ duration, segments })
    })
  })
}

const round = n => Math.round(n * 100) / 100

const ENDS = /[.!?。！？…"”']$/

/**
 * 把 VAD 片段拼成句子：前一段很短（<1.6s）或没说完（没有句末标点），且停顿 <1.2s、拼完不超过 14s，就接上
 */
export function mergeSegments(segs, { maxGap = 1.2, maxLen = 14, short = 1.6 } = {}) {
  const out = []
  for (const s of segs) {
    const text = String(s.text || '').trim()
    if (!text) continue
    const prev = out[out.length - 1]
    if (prev) {
      const gap = s.start - prev.end
      const prevShort = prev.end - prev.start < short
      const unfinished = !ENDS.test(prev.text)
      if (gap < maxGap && (prevShort || unfinished) && s.end - prev.start <= maxLen) {
        prev.end = s.end
        prev.text = joinText(prev.text, text)
        continue
      }
    }
    out.push({ start: s.start, end: s.end, text })
  }
  return out
}

/** "First." + "Your energy…" → "First, your energy…" 不改；只是用空格接上，交给翻译那一步去校对 */
function joinText(a, b) {
  return `${a} ${b}`.replace(/\s+/g, ' ').trim()
}

/** 压缩成单声道 64 kbps MP3（固定码率，浏览器跳转到某一秒才准） */
export function compactAudio(src, dest, opt = {}) {
  const ffmpeg = findFfmpeg(opt.ffmpeg)
  if (!ffmpeg) return Promise.reject(new Error(FFMPEG_HINT))
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', src, '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '44100',
      '-codec:a', 'libmp3lame', '-b:a', '64k', dest], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000) })
    const onAbort = () => child.kill('SIGKILL')
    if (opt.signal) opt.signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', reject)
    child.on('close', code => {
      if (opt.signal) opt.signal.removeEventListener('abort', onAbort)
      if (code === 0) resolve(dest)
      else reject(new Error(`音频压缩失败：${stderr.trim().split('\n').slice(-2).join(' ')}`))
    })
  })
}
