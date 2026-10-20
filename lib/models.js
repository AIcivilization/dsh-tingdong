// lib/models.js — 本地语音识别模型（SenseVoice + Silero VAD）
//
// 和 DSH 自带的「语音输入」用同一套模型、同一个固定版本（sha256 一致）：
// 用过 DSH 语音输入的机器上已经下好了（~/.dsh/speech-to-text/sensevoice/models），直接复用，不再下载 240 MB。
// 没有就下载到本插件自己的目录，先试 huggingface.co，连不上换 hf-mirror.com。

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dataRoot } from './paths.js'

const HF = 'https://huggingface.co'
const SV = '/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07'

export const ASSETS = {
  model: { dir: 'sensevoice-onnx', name: 'model.int8.onnx', path: SV + '/model.int8.onnx', bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  tokens: { dir: 'sensevoice-onnx', name: 'tokens.txt', path: SV + '/tokens.txt', bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
  vad: { dir: 'silero', name: 'silero_vad.onnx', path: '/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx', bytes: 1807522, sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28' },
}

const ORIGINS = [HF, 'https://hf-mirror.com']

/** 可能已经有模型的目录：DSH 语音输入的、本插件自己的 */
function modelRoots(extra) {
  return [extra, join(homedir(), '.dsh', 'speech-to-text', 'sensevoice', 'models'), join(dataRoot(), 'models')].filter(Boolean)
}

/** 只比大小（快）：完整性在下载时用 sha256 校验过 */
async function sizeMatches(path, asset) {
  try { return (await stat(path)).size === asset.bytes } catch { return false }
}

/** 找已有模型；三个文件都在才算 @returns {{model,tokens,vad}|null} */
export async function findModels(extraRoot) {
  const found = {}
  for (const key of Object.keys(ASSETS)) {
    const a = ASSETS[key]
    for (const root of modelRoots(extraRoot)) {
      const p = join(root, a.dir, a.name)
      if (existsSync(p) && await sizeMatches(p, a)) { found[key] = p; break }
    }
    if (!found[key]) return null
  }
  return found
}

async function sha256(path) {
  const h = createHash('sha256')
  for await (const c of createReadStream(path)) h.update(c)
  return h.digest('hex')
}

async function download(asset, root, onProgress, signal) {
  const dir = join(root, asset.dir)
  const dest = join(dir, asset.name)
  if (await sizeMatches(dest, asset)) return dest
  await mkdir(dir, { recursive: true })
  let lastError
  for (const origin of ORIGINS) {
    const part = `${dest}.${process.pid}.part`
    try {
      const res = await fetch(origin + asset.path, { signal, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      let done = 0
      const meter = new Transform({
        transform(chunk, _enc, cb) { done += chunk.length; onProgress && onProgress(asset.name, done, asset.bytes); cb(null, chunk) },
      })
      await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(part), { signal })
      if (await sha256(part) !== asset.sha256) throw new Error('文件校验不通过')
      await rename(part, dest)
      return dest
    } catch (e) {
      lastError = e
      await rm(part, { force: true })
      if (signal && signal.aborted) throw e
    }
  }
  throw new Error(`下载 ${asset.name} 失败：${lastError && lastError.message}`)
}

/** 找不到就下载（约 241 MB） */
export async function ensureModels({ extraRoot, onProgress, signal } = {}) {
  const have = await findModels(extraRoot)
  if (have) return have
  const root = join(dataRoot(), 'models')
  const out = {}
  for (const key of Object.keys(ASSETS)) out[key] = await download(ASSETS[key], root, onProgress, signal)
  return out
}
