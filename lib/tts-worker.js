// lib/tts-worker.js — 朗读子进程：把每句英文读出来，拼成一条声音轨
//
// Kokoro（sherpa-onnx）是同步推理，和识别一样放在单独进程里；macOS 的 say 也在这里一句一句调。
// 输入：argv[2] 的 JSON { engine:'kokoro'|'say', voice, speed, sentences:[{i,text}], kokoroDir, ffmpeg, out, gap }
// 输出：stdout 每行一个 JSON：{type:'progress',done,total} / {type:'done',items,duration} / {type:'error',message}

import { execFile } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEncoder, parseWav, RATE, trimSilence } from './pcm.js'
import { KOKORO_IDS } from './voices.js'

const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n')

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

async function main() {
  const opt = JSON.parse(process.argv[2] || '{}')
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
