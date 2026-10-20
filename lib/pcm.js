// lib/pcm.js — 声音轨的公共部分：一句一段的 PCM（24 kHz 单声道 float）拼起来，中间留固定停顿，编码成 MP3
//
// 原声去空白、系统朗读、Kokoro 朗读都走这里，所以每条声音轨都带同样格式的时间表：
// items[i] = [start, end]（秒，相对这条声音轨）。

import { spawn } from 'node:child_process'

export const RATE = 24000

/** 读 float32 / int16 的 WAV（逐块找 fmt 和 data：macOS say 的文件里夹着 FLLR 填充块） */
export function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAV')
  let fmt = null
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
    if (id === 'data') {
      if (!fmt) throw new Error('WAV 缺 fmt')
      const end = Math.min(buf.length, body + size)
      const data = buf.subarray(body, end)
      let samples
      if (fmt.format === 3 && fmt.bits === 32) {
        samples = new Float32Array(data.length / 4)
        new Uint8Array(samples.buffer).set(data.subarray(0, samples.length * 4))
      } else if (fmt.format === 1 && fmt.bits === 16) {
        samples = new Float32Array(data.length / 2)
        for (let k = 0; k < samples.length; k++) samples[k] = data.readInt16LE(k * 2) / 32768
      } else throw new Error(`不支持的 WAV 格式 ${fmt.format}/${fmt.bits}`)
      if (fmt.channels > 1) samples = samples.filter((_, k) => k % fmt.channels === 0)
      return { samples, rate: fmt.rate }
    }
    off = body + size + (size % 2)
  }
  throw new Error('WAV 缺 data')
}

/** 去掉首尾的静音（TTS 常在前后留一截），阈值很低，只切真正的静音 */
export function trimSilence(samples, rate = RATE, keep = 0.05) {
  const thr = 0.003
  let a = 0
  let b = samples.length
  while (a < b && Math.abs(samples[a]) < thr) a++
  while (b > a && Math.abs(samples[b - 1]) < thr) b--
  const pad = Math.round(keep * rate)
  return samples.subarray(Math.max(0, a - pad), Math.min(samples.length, b + pad))
}

/**
 * 一边收句子一边编码：write(i, samples) 按顺序调用，finish() 返回时间表
 * @param {object} o { ffmpeg, out, flac?（同时出一份 FLAC 的路径）, gap=0.7, bitrate='64k', signal }
 */
export function createEncoder(o) {
  const gap = o.gap ?? 0.7
  const args = ['-hide_banner', '-nostdin', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0',
    '-codec:a', 'libmp3lame', '-b:a', o.bitrate || '64k', o.out]
  // 同时出一份无损 FLAC（44.1 kHz / 16 位，和 CD 一样，播放器都认）：从同一份原始音频编码，不是拿 MP3 转的
  if (o.flac) args.push('-ar', '44100', '-sample_fmt', 's16', '-codec:a', 'flac', o.flac)
  const ff = spawn(o.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  ff.stderr.on('data', d => { stderr = (stderr + d).slice(-3000) })
  let broken = null
  // ffmpeg 中途退出时往里写会 EPIPE：别让它变成未捕获的异常，记下来交给 finish() 报
  ff.stdin.on('error', e => { broken = e })
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject)
    ff.on('close', code => (code === 0 ? resolve() : reject(new Error(`MP3 编码失败：${stderr.trim().split('\n').slice(-2).join(' ')}`))))
  })
  const onAbort = () => ff.kill('SIGKILL')
  if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true })
  const silence = new Float32Array(Math.round(gap * RATE))
  const items = {}
  let pos = 0
  let first = true

  const push = async (f32) => {
    if (!f32.length) return
    if (broken || ff.exitCode !== null) throw new Error(`MP3 编码进程已退出：${stderr.trim().split('\n').slice(-2).join(' ') || (broken && broken.message)}`)
    const ok = ff.stdin.write(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength))
    if (!ok) await new Promise(r => ff.stdin.once('drain', r))
  }
  return {
    /** 写一段；i 不为 null 时记进时间表。返回这段在声音轨里的 [start, end] */
    async write(i, samples) {
      if (!first && silence.length) { await push(silence); pos += silence.length }
      first = false
      // 复制一份（Buffer 直接引用原生内存时，写完前不能被回收），顺手清洗：
      // 合成偶尔吐出 NaN / 无穷大，LAME 碰到会直接断言崩溃
      const copy = Float32Array.from(samples, v => (Number.isFinite(v) ? (v > 1 ? 1 : v < -1 ? -1 : v) : 0))
      const span = [round(pos / RATE), round((pos + copy.length) / RATE)]
      if (i !== null && i !== undefined) items[i] = span
      await push(copy)
      pos += copy.length
      return span
    },
    /** 插一段静音（秒） */
    async pad(seconds) {
      const n = Math.round(seconds * RATE)
      if (n > 0) { await push(new Float32Array(n)); pos += n }
    },
    get seconds() { return pos / RATE },
    async finish() {
      // 结尾留半秒静音，播放器停得不突兀
      ff.stdin.end(Buffer.from(new Float32Array(Math.round(0.5 * RATE)).buffer))
      try { await done } finally { if (o.signal) o.signal.removeEventListener('abort', onAbort) }
      if (o.signal && o.signal.aborted) throw new Error('已取消')
      return { items, duration: round(pos / RATE + 0.5) }
    },
    abort() { ff.kill('SIGKILL') },
  }
}

const round = n => Math.round(n * 1000) / 1000
