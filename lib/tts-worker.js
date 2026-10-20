// lib/tts-worker.js — 朗读子进程：把每句英文读出来，拼成一条声音轨
//
// Kokoro（sherpa-onnx）是同步推理，和识别一样放在单独进程里；macOS 的 say 也在这里一句一句调。
// 输入：argv[2] 的 JSON { engine:'kokoro'|'say'|'kokoro-zh', voice, sid, speed, sentences:[{i,text,start?,slot?}], kokoroDir, ffmpeg, out, gap, total? }
// 有 total 时按时间表放：每句放在它的 start，其余是静音，总长 total（中文对译用）；没有就一句接一句、句间停 gap 秒。
// 输出：stdout 每行一个 JSON：{type:'progress',done,total} / {type:'done',items,duration} / {type:'error',message}

import { execFile, spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEncoder, parseWav, RATE, trimSilence } from './pcm.js'
import { KOKORO_IDS } from './voices.js'
import { edgeSpeak } from './edge.js'

const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n')

/** 中文：去掉引号书名号，括号里的注释不读 */
function tidyZh(text) {
  return String(text || '')
    .replace(/[“”"「」『』《》]/g, '')
    .replace(/（[^）]*）|\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 朗读前把文字理一理：引号、破折号会让 TTS 读出怪停顿 */
function tidy(text) {
  return String(text || '')
    .replace(/[“”"]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\.\.\./g, '…')
    .trim()
}

function kokoroEngine(opt) {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
  const d = opt.kokoroDir
  const tts = new sherpa.OfflineTts({
    model: {
      kokoro: { model: join(d, 'model.int8.onnx'), voices: join(d, 'voices.bin'), tokens: join(d, 'tokens.txt'), dataDir: join(d, 'espeak-ng-data') },
      numThreads: opt.threads || 2, provider: 'cpu', debug: 0,
    },
    maxNumSentences: 1,
  })
  const sid = Math.max(0, KOKORO_IDS.indexOf(opt.voice || 'am_michael'))
  return async (text) => {
    const a = tts.generate({ text, sid, speed: opt.speed || 0.9 })
    // Kokoro 本身就是 24 kHz
    return trimSilence(Float32Array.from(a.samples))
  }
}

/** Kokoro v1.1-zh：普通话，speed 可以每句不同（太长的句子读快一点塞进空档） */
function kokoroZhEngine(opt) {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
  const d = opt.kokoroDir
  const tts = new sherpa.OfflineTts({
    model: {
      kokoro: {
        model: join(d, 'model.int8.onnx'), voices: join(d, 'voices.bin'), tokens: join(d, 'tokens.txt'),
        dataDir: join(d, 'espeak-ng-data'), dictDir: join(d, 'dict'),
        lexicon: [join(d, 'lexicon-us-en.txt'), join(d, 'lexicon-zh.txt')].join(','),
      },
      numThreads: opt.threads || 2, provider: 'cpu', debug: 0,
    },
    ruleFsts: ['date-zh.fst', 'phone-zh.fst', 'number-zh.fst'].map(f => join(d, f)).join(','),
    maxNumSentences: 1,
  })
  return async (text, speed) => {
    const a = tts.generate({ text, sid: opt.sid ?? 3, speed: speed || opt.speed || 1 })
    return trimSilence(Float32Array.from(a.samples))
  }
}

/** MP3 → 24 kHz 单声道 float */
function decodeMp3(ffmpeg, file) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    ff.stdout.on('data', c => chunks.push(c))
    ff.on('error', reject)
    ff.on('close', code => {
      if (code !== 0) return reject(new Error(`解码失败（${code}）`))
      const b = Buffer.concat(chunks)
      const f = new Float32Array(Math.floor(b.length / 4))
      new Uint8Array(f.buffer).set(b.subarray(0, f.length * 4))
      resolve(f)
    })
  })
}

/** 微软 Edge 在线语音（经 edge-tts 命令行） */
function edgeEngine(opt) {
  let n = 0
  return async (text, speed) => {
    const tmp = join(tmpdir(), `tingdong-edge-${process.pid}-${n++}.mp3`)
    try {
      await edgeSpeak(text, opt.voice, speed || opt.speed || 1, tmp)
      return trimSilence(await decodeMp3(opt.ffmpeg, tmp))
    } finally { rmSync(tmp, { force: true }) }
  }
}

function sayEngine(opt) {
  const wpm = String(Math.round(175 * (opt.speed || 0.9)))
  let n = 0
  return async (text) => {
    const tmp = join(tmpdir(), `tingdong-say-${process.pid}-${n++}.wav`)
    const run = () => new Promise((resolve, reject) => execFile('say', ['-v', opt.voice || 'Samantha', '-r', wpm, '--file-format=WAVE', `--data-format=LEF32@${RATE}`, '-o', tmp, text],
      { timeout: 60000 }, err => (err ? reject(new Error(`say 失败：${err.message}`)) : resolve())))
    // 几个 say 同时跑时系统语音服务偶尔失败一次：歇一下重试
    for (let attempt = 1; ; attempt++) {
      try { await run(); break } catch (e) {
        if (attempt >= 3) throw e
        await new Promise(r => setTimeout(r, 500 * attempt))
      }
    }
    try { return trimSilence(parseWav(readFileSync(tmp)).samples) } finally { rmSync(tmp, { force: true }) }
  }
}

/** 按时间表放（中文对译）：每句放在 start；比空档长就读快一点，最快 1.6 倍 */
async function timeline(opt, speak) {
  const enc = createEncoder({ ffmpeg: opt.ffmpeg, out: opt.out, gap: 0, bitrate: opt.bitrate })
  const list = (opt.sentences || []).map(s => ({ ...s, text: tidyZh(s.text) })).filter(s => s.text).sort((a, b) => a.start - b.start)
  const base = opt.speed || 1
  let squeezed = 0
  // Edge 走网络：先按正常语速同时请求几句；Kokoro 是同步推理，提前排队也只是顺序执行
  const AHEAD = opt.engine === 'edge-zh' ? 4 : 1
  const pending = []
  let next = 0
  const fill = () => { while (next < list.length && pending.length < AHEAD) { const t = list[next++].text; const p = speak(t, base); p.catch(() => {}); pending.push(p) } }
  fill()
  for (const [k, s] of list.entries()) {
    let pcm = await pending.shift()
    fill()
    const len = pcm.length / RATE
    if (s.slot && len > s.slot) {
      const faster = Math.min(1.6, base * (len / s.slot) * 1.04)
      pcm = await speak(s.text, faster)
      squeezed++
    }
    await enc.pad(s.start - enc.seconds)
    await enc.write(s.i, pcm)
    emit({ type: 'progress', done: k + 1, total: list.length })
  }
  await enc.pad((opt.total || 0) - enc.seconds - 0.5)
  const res = await enc.finish()
  emit({ type: 'done', ...res, squeezed })
}

async function main() {
  const opt = JSON.parse(process.argv[2] || '{}')
  if (opt.engine === 'kokoro-zh') return timeline(opt, kokoroZhEngine(opt))
  if (opt.engine === 'edge-zh') return timeline(opt, edgeEngine(opt))
  const speak = opt.engine === 'kokoro' ? kokoroEngine(opt) : sayEngine(opt)
  const enc = createEncoder({ ffmpeg: opt.ffmpeg, out: opt.out, gap: opt.gap ?? 0.7 })
  const list = (opt.sentences || []).map(s => ({ i: s.i, text: tidy(s.text) })).filter(s => s.text)
  // say 是独立进程，可以同时跑几个；写入仍按句子顺序。Kokoro 是同步推理，提前排队也只是顺序执行
  const AHEAD = opt.engine === 'say' ? 4 : 1
  const pending = []
  let next = 0
  const fill = () => { while (next < list.length && pending.length < AHEAD) { const s = list[next++]; pending.push(speak(s.text).then(pcm => ({ i: s.i, pcm }))) } }
  fill()
  for (let k = 0; k < list.length; k++) {
    const { i, pcm } = await pending.shift()
    fill()
    await enc.write(i, pcm)
    emit({ type: 'progress', done: k + 1, total: list.length })
  }
  const res = await enc.finish()
  emit({ type: 'done', ...res })
}

main().then(() => process.exit(0), e => { emit({ type: 'error', message: e && e.message ? e.message : String(e) }); process.exit(1) })
