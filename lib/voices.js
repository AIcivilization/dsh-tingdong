// lib/voices.js — 有哪些朗读声音：Kokoro（离线神经网络语音）和 macOS 系统语音

import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dataRoot } from './paths.js'

/** Kokoro v0.19 英文模型的 11 个声音（顺序就是模型里的 speaker id） */
export const KOKORO_VOICES = [
  { id: 'am_michael', label: 'Michael（美式男声）' },
  { id: 'am_adam', label: 'Adam（美式男声）' },
  { id: 'bm_george', label: 'George（英式男声）' },
  { id: 'bm_lewis', label: 'Lewis（英式男声）' },
  { id: 'af_sarah', label: 'Sarah（美式女声）' },
  { id: 'af_bella', label: 'Bella（美式女声）' },
  { id: 'af_nicole', label: 'Nicole（美式女声）' },
  { id: 'af_sky', label: 'Sky（美式女声）' },
  { id: 'af', label: 'Default（美式女声）' },
  { id: 'bf_emma', label: 'Emma（英式女声）' },
  { id: 'bf_isabella', label: 'Isabella（英式女声）' },
]
export const KOKORO_IDS = ['af', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'am_adam', 'am_michael', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis']

const KOKORO = {
  name: 'kokoro-int8-en-v0_19',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2',
  bytes: 103248205,
  modelBytes: 134186977,
}

export const kokoroDir = () => join(dataRoot(), 'models', KOKORO.name)

export async function kokoroReady() {
  try { return (await stat(join(kokoroDir(), 'model.int8.onnx'))).size === KOKORO.modelBytes && existsSync(join(kokoroDir(), 'voices.bin')) } catch { return false }
}

/** 没有就下载（约 103 MB）并解压 */
export async function ensureKokoro({ onProgress, signal } = {}) {
  if (await kokoroReady()) return kokoroDir()
  const root = join(dataRoot(), 'models')
  await mkdir(root, { recursive: true })
  const part = join(root, `${KOKORO.name}.${process.pid}.tar.bz2`)
  try {
    const res = await fetch(KOKORO.url, { signal, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    let got = 0
    const meter = new Transform({ transform(c, _e, cb) { got += c.length; onProgress && onProgress(got, KOKORO.bytes); cb(null, c) } })
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(part), { signal })
    if ((await stat(part)).size !== KOKORO.bytes) throw new Error('文件大小不对')
    const tmpDir = join(root, `.extract-${process.pid}`)
    await rm(tmpDir, { recursive: true, force: true })
    await mkdir(tmpDir)
    await new Promise((resolve, reject) => {
      const t = spawn('tar', ['-xjf', part, '-C', tmpDir], { stdio: 'ignore' })
      t.on('error', reject)
      t.on('close', code => (code === 0 ? resolve() : reject(new Error(`解压失败（${code}）`))))
    })
    await rm(kokoroDir(), { recursive: true, force: true })
    await rename(join(tmpDir, KOKORO.name), kokoroDir())
    await rm(tmpDir, { recursive: true, force: true })
  } catch (e) {
    throw new Error(`下载 Kokoro 语音模型失败：${e.message}`)
  } finally {
    await rm(part, { force: true })
  }
  if (!await kokoroReady()) throw new Error('Kokoro 语音模型不完整')
  return kokoroDir()
}

/**
 * macOS 的英文系统语音，好的排前面：Premium > Enhanced > 普通。
 * 只留正常人声（去掉 Bells、Zarvox 这类效果音）。
 * @returns {Promise<{id:string, label:string, quality:number}[]>}
 */
export function sayVoices() {
  if (process.platform !== 'darwin') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile('say', ['-v', '?'], { timeout: 8000 }, (err, out) => {
      if (err) return resolve([])
      const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy|Grandma|Grandpa|Rocko|Eddy|Flo|Reed|Sandy|Shelley)\b/
      // 同一个声音会以「Samantha」「Samantha (英语（美国）)」多次出现：say -v 用括号前的名字，按名字 + 口音去重
      const REGION = { US: '美式', GB: '英式', AU: '澳洲', IE: '爱尔兰', IN: '印度', ZA: '南非' }
      const order = r => (r === 'US' ? 0 : r === 'GB' ? 1 : 2)
      const seen = new Set()
      const list = []
      for (const line of String(out).split('\n')) {
        const m = /^(.+?)\s+en_([A-Z]{2})\s+#/.exec(line)
        if (!m) continue
        const full = m[1].trim()
        const id = full.replace(/\s*\(.*\)\s*$/, '')
        const quality = /premium|高级|優化|优化/i.test(full) ? 3 : /enhanced|增强|增強/i.test(full) ? 2 : NOVELTY.test(id) ? 0 : 1
        if (!quality || seen.has(id)) continue
        seen.add(id)
        const tag = quality === 3 ? '·高级' : quality === 2 ? '·增强' : ''
        list.push({ id, label: `${id}（${REGION[m[2]] || m[2]}${tag}）`, quality, region: m[2] })
      }
      list.sort((a, b) => b.quality - a.quality || order(a.region) - order(b.region)
        || (a.id === 'Samantha' ? -1 : b.id === 'Samantha' ? 1 : a.id.localeCompare(b.id)))
      resolve(list)
    })
  })
}

export const SAY_HINT =
  '想要更自然的系统朗读：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音…，在英语里下载带「高级」或「增强」的声音（如 Ava、Zoe、Evan），装好后这里会自动列出来并排在最前。'
