// lib/asr-worker.js — 识别子进程：ffmpeg 解码 → Silero VAD 切句 → SenseVoice 识别
//
// sherpa-onnx 的推理是同步的，放在 DSH 主进程里会卡住整个界面，所以单独起一个进程
// （和 DSH 自带语音输入的做法一样：process.execPath + ELECTRON_RUN_AS_NODE=1）。
// 音频边解码边处理，内存占用和音频长短无关。
//
// 输入：argv[2] 是 JSON 参数。输出：stdout 每行一个 JSON 事件：
//   {type:'duration', seconds}  {type:'progress', seconds}  {type:'segment', start, end, text}
//   {type:'done', segments, inferenceSeconds}  {type:'error', message}

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const RATE = 16000
const WINDOW = 512

const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n')

function main() {
  const opt = JSON.parse(process.argv[2] || '{}')
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
  const threads = opt.threads || 2

  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: opt.models.model, language: opt.language || 'en', useInverseTextNormalization: 1 },
      tokens: opt.models.tokens, numThreads: threads, provider: 'cpu', debug: 0,
    },
  })
  const maxSpeech = opt.maxSpeechSeconds || 20
  const minSilence = opt.minSilenceSeconds || 0.6
  const vad = new sherpa.Vad({
    sileroVad: {
      model: opt.models.vad, threshold: opt.vadThreshold || 0.5, minSilenceDuration: minSilence,
      minSpeechDuration: 0.25, maxSpeechDuration: maxSpeech, windowSize: WINDOW,
    },
    sampleRate: RATE, numThreads: 1, provider: 'cpu', debug: 0,
  }, maxSpeech + minSilence + 5)

  let count = 0
  let inference = 0
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front(false)
      const t0 = performance.now()
      const stream = recognizer.createStream()
      stream.acceptWaveform({ sampleRate: RATE, samples: seg.samples })
      recognizer.decode(stream)
      const text = recognizer.getResult(stream).text.trim()
      inference += performance.now() - t0
      if (text) {
        count++
        emit({ type: 'segment', start: seg.start / RATE, end: (seg.start + seg.samples.length) / RATE, text })
      }
      vad.pop()
    }
  }

  const ff = spawn(opt.ffmpeg, ['-hide_banner', '-nostdin', '-i', opt.file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  ff.stderr.on('data', d => {
    stderr = (stderr + d.toString('utf8')).slice(-8000)
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
    if (m && !main.sentDuration) { main.sentDuration = true; emit({ type: 'duration', seconds: +m[1] * 3600 + +m[2] * 60 + +m[3] }) }
  })

  let carry = Buffer.alloc(0)
  let fed = 0
  let lastReport = 0
  let pending = new Float32Array(0)
  ff.stdout.on('data', chunk => {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
    const usable = buf.length - (buf.length % 4)
    carry = buf.subarray(usable)
    // 复制一份：Electron 的 V8 内存笼不允许直接把 Node Buffer 交给原生代码
    const fresh = new Float32Array(usable / 4)
    new Uint8Array(fresh.buffer).set(buf.subarray(0, usable))
    let samples = fresh
    if (pending.length) { samples = new Float32Array(pending.length + fresh.length); samples.set(pending); samples.set(fresh, pending.length) }
    let i = 0
    for (; i + WINDOW <= samples.length; i += WINDOW) {
      vad.acceptWaveform(samples.subarray(i, i + WINDOW))
      drain()
    }
    pending = samples.slice(i)
    fed += usable / 4
    if (fed - lastReport > RATE * 10) { lastReport = fed; emit({ type: 'progress', seconds: fed / RATE }) }
  })
  ff.on('error', e => { emit({ type: 'error', message: `ffmpeg 启动失败：${e.message}` }); process.exit(1) })
  ff.on('close', code => {
    if (code !== 0) {
      emit({ type: 'error', message: `ffmpeg 解码失败（${code}）：${stderr.trim().split('\n').slice(-2).join(' ')}` })
      process.exit(1)
    }
    if (pending.length) vad.acceptWaveform(pending)
    vad.flush()
    drain()
    emit({ type: 'progress', seconds: fed / RATE })
    emit({ type: 'done', segments: count, inferenceSeconds: inference / 1000 })
    process.exit(0)
  })
}

try {
  main()
} catch (e) {
  emit({ type: 'error', message: e && e.message ? e.message : String(e) })
  process.exit(1)
}
