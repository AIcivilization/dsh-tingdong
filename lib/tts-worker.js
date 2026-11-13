// lib/tts-worker.js — 朗读子进程：把每句英文读出来，拼成一条声音轨
//
// Kokoro（sherpa-onnx）是同步推理，和识别一样放在单独进程里；macOS 的 say 也在这里一句一句调。
// Mac 本机 Ming 是 Python（mlx-audio），由这里再起一个 Python 进程。
// 输入：argv[2] 的 JSON { engine:'kokoro'|'say'|'kokoro-zh'|'edge-zh'|'ming-zh'|'edge-en', voice, sid, speed, sentences:[{i,text,start?,slot?}], kokoroDir, ming?, ffmpeg, out, gap, total? }
// 有 total 时按时间表放：每句放在它的 start，其余是静音，总长 total（中文对译用）；没有就一句接一句、句间停 gap 秒。
// 输出：stdout 每行一个 JSON：{type:'progress',done,total} / {type:'done',items,duration} / {type:'error',message}

import { execFile, spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEncoder, parseWav, RATE, trimSilence } from './pcm.js'
import { createInterface } from 'node:readline'
import { KOKORO_IDS } from './voices.js'
import { edgeSpeak } from './edge.js'
import { MING_WORKER } from './ming.js'
import { spokenNumbers } from './spoken.js'

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

/** 喂给 ffmpeg 一段声音，拿回 24 kHz 单声道 float；filter 可以是 atempo 之类 */
function ffPipe(ffmpeg, input, inArgs, filter) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', ...inArgs, '-i', 'pipe:0', ...(filter ? ['-af', filter] : []), '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1']
    const ff = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    let err = ''
    ff.stdout.on('data', c => chunks.push(c))
    ff.stderr.on('data', d => { err = (err + d).slice(-1000) })
    ff.stdin.on('error', () => {}) // ffmpeg 先退出时别把整个进程带崩，错误从 close 里报
    ff.on('error', reject)
    ff.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg 处理声音失败（${code}）：${err.trim().split('\n').pop()}`))
      const b = Buffer.concat(chunks)
      const f = new Float32Array(Math.floor(b.length / 4))
      new Uint8Array(f.buffer).set(b.subarray(0, f.length * 4))
      resolve(f)
    })
    ff.stdin.end(input)
  })
}

/**
 * Mac 本机 Ming（mlx-audio）：一个 Python 进程加载一次模型，一句一句合成（44.1 kHz），转成 24 kHz。
 * Ming 只有「慢速 / 快速」两档，配音要的是刚好塞进空档：变速一律用 ffmpeg 的 atempo（不变调），
 * 同一句先合成一次，要读快就在这份声音上加速，不重新合成。
 */
function mingEngine(opt) {
  const py = spawn(opt.ming.python, ['-I', MING_WORKER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', PYTHONUNBUFFERED: '1' },
  })
  const waiting = new Map()
  let nextId = 1
  let tail = ''
  let dead = null
  py.stdin.on('error', () => {})
  py.stderr.on('data', d => { tail = (tail + d).slice(-1500) })
  createInterface({ input: py.stdout }).on('line', line => {
    let r
    try { r = JSON.parse(line) } catch { return }
    const w = waiting.get(r.id)
    if (!w) return
    waiting.delete(r.id)
    if (r.ok) w.resolve(r)
    else w.reject(new Error(`本机 Ming 合成失败：${r.error}`))
  })
  const fail = why => {
    dead = new Error(`本机 Ming 退出了（${why}）：${tail.trim().split('\n').slice(-2).join(' ')}`)
    for (const w of waiting.values()) w.reject(dead)
    waiting.clear()
  }
  py.on('error', e => fail(e.message))
  py.on('exit', code => fail(`退出码 ${code}`))
  const send = msg => {
    if (dead) return Promise.reject(dead)
    const id = nextId++
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      py.stdin.write(JSON.stringify({ ...msg, id }) + '\n')
    })
  }
  const loaded = send({ op: 'load', model: opt.ming.model })
  loaded.catch(() => {})
  let last = { text: null, pcm: null } // 只留上一句：读快一点要用同一份声音
  return async (text, speed) => {
    await loaded
    if (last.text !== text) {
      const r = await send({ op: 'speak', text: spokenNumbers(text), voice: opt.voice, steps: 10 })
      const pcm = trimSilence(await ffPipe(opt.ffmpeg, Buffer.from(r.pcm16, 'base64'), ['-f', 's16le', '-ar', String(r.sampleRate), '-ac', '1']))
      last = { text, pcm }
    }
    const t = Math.min(2, Math.max(0.5, speed || 1))
    if (Math.abs(t - 1) < 0.01) return last.pcm
    const raw = Buffer.from(last.pcm.buffer, last.pcm.byteOffset, last.pcm.byteLength)
    return ffPipe(opt.ffmpeg, raw, ['-f', 'f32le', '-ar', String(RATE), '-ac', '1'], `atempo=${t.toFixed(3)}`)
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
  const enc = createEncoder({ ffmpeg: opt.ffmpeg, out: opt.out, flac: opt.flac, gap: 0, bitrate: opt.bitrate })
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

/**
 * 文档朗读：一句接一句，停顿由每句的 pause（这句之前停几秒）决定——
 * 句与句之间短、段落之间长，小标题后面也停一下，听起来像人在念书
 */
async function reading(opt, speak) {
  const enc = createEncoder({ ffmpeg: opt.ffmpeg, out: opt.out, gap: 0, bitrate: opt.bitrate })
  const list = (opt.sentences || []).map(s => ({ ...s, text: tidy(s.text) })).filter(s => s.text)
  const AHEAD = opt.engine === 'edge-en' ? 4 : 1
  const pending = []
  let next = 0
  const fill = () => { while (next < list.length && pending.length < AHEAD) { const p = speak(list[next++].text); p.catch(() => {}); pending.push(p) } }
  fill()
  for (const [k, s] of list.entries()) {
    const pcm = await pending.shift()
    fill()
    if (k) await enc.pad(s.pause ?? 0.6)
    await enc.write(s.i, pcm)
    emit({ type: 'progress', done: k + 1, total: list.length })
  }
  const res = await enc.finish()
  emit({ type: 'done', ...res })
}

async function main() {
  const opt = JSON.parse(process.argv[2] || '{}')
  if (opt.engine === 'kokoro-zh') return timeline(opt, kokoroZhEngine(opt))
  if (opt.engine === 'edge-zh') return timeline(opt, edgeEngine(opt))
  if (opt.engine === 'ming-zh') return timeline(opt, mingEngine(opt))
  if (opt.engine === 'edge-en') return reading(opt, edgeEngine(opt))
  if (opt.mode === 'reading') return reading(opt, kokoroEngine(opt))
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
