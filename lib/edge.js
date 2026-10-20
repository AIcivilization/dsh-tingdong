// lib/edge.js — 微软 Edge「大声朗读」的在线神经网络语音（晓晓、云希……）
//
// 不自己实现它的私有鉴权：调用开源命令行工具 edge-tts（https://github.com/rany2/edge-tts），
// 装在本插件自己的 Python 虚拟环境里（~/.dsh/dsh-tingdong/edge-tts），不碰系统 Python，删掉目录即卸载。
// 微软改协议时，edge-tts 更新一下（界面上「更新 Edge 语音组件」）就好。
// 注意：要联网，文字会发到微软的服务器；不是微软公开的正式接口，可能失效。

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot } from './paths.js'

export const EDGE_ZH_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女 · 温暖）', gender: 'f' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女 · 活泼）', gender: 'f' },
  { id: 'zh-CN-YunxiNeural', label: '云希（男 · 阳光）', gender: 'm' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（男 · 新闻播报）', gender: 'm' },
  { id: 'zh-CN-YunjianNeural', label: '云健（男 · 激情）', gender: 'm' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏（男 · 童声）', gender: 'm' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（女 · 辽宁话）', gender: 'f' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮（女 · 陕西话）', gender: 'f' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻（女 · 台湾）', gender: 'f' },
  { id: 'zh-TW-HsiaoYuNeural', label: '曉雨（女 · 台湾）', gender: 'f' },
  { id: 'zh-TW-YunJheNeural', label: '雲哲（男 · 台湾）', gender: 'm' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼（女 · 粤语）', gender: 'f' },
  { id: 'zh-HK-HiuGaaiNeural', label: '曉佳（女 · 粤语）', gender: 'f' },
  { id: 'zh-HK-WanLungNeural', label: '雲龍（男 · 粤语）', gender: 'm' },
]
export const edgeVoice = id => EDGE_ZH_VOICES.find(v => v.id === id) || EDGE_ZH_VOICES[0]

export const edgeDir = () => join(dataRoot(), 'edge-tts')
const win = process.platform === 'win32'
const venvBin = name => join(edgeDir(), win ? 'Scripts' : 'bin', win ? `${name}.exe` : name)

/** edge-tts 命令在哪：插件自己装的优先，其次系统里已有的 */
export function edgeBin() {
  if (existsSync(venvBin('edge-tts'))) return venvBin('edge-tts')
  for (const p of ['/opt/homebrew/bin/edge-tts', '/usr/local/bin/edge-tts', '/usr/bin/edge-tts']) if (existsSync(p)) return p
  return null
}

function run(cmd, args, timeout = 300000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n').slice(-2).join(' ')))
      resolve(String(stdout))
    })
  })
}

function findPython() {
  const c = win ? ['py', 'python', 'python3'] : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3']
  return c.find(p => !p.includes('/') || existsSync(p)) || null
}

export async function edgeStatus() {
  const bin = edgeBin()
  if (!bin) return { ready: false }
  try { return { ready: true, version: (await run(bin, ['--version'], 15000)).trim().replace(/^edge-tts\s*/, '') } } catch { return { ready: false } }
}

/** 装（或更新）edge-tts 到插件自己的虚拟环境 */
export async function installEdge() {
  const py = findPython()
  if (!py) throw Object.assign(new Error('没找到 Python 3：Mac 上装好 Xcode 命令行工具（xcode-select --install），Linux 上 sudo apt install python3 python3-venv'), { status: 400 })
  const venvPy = join(edgeDir(), win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python')
  if (!existsSync(venvPy)) {
    await rm(edgeDir(), { recursive: true, force: true })
    try { await run(py, ['-m', 'venv', edgeDir()]) } catch (e) {
      throw Object.assign(new Error(`建 Python 虚拟环境失败：${e.message}（Linux 上先 sudo apt install python3-venv）`), { status: 400 })
    }
  }
  await run(venvPy, ['-m', 'pip', 'install', '-q', '--upgrade', 'edge-tts'])
  return edgeStatus()
}

/**
 * 读一句，存成 MP3（24 kHz 单声道）
 * @param {number} speed 1 = 正常；1.3 = 快 30%
 */
export async function edgeSpeak(text, voice, speed, out) {
  const bin = edgeBin()
  if (!bin) throw new Error('还没装 Edge 语音组件：在「导出 → 中文配音」里点「安装 Edge 语音组件」')
  const pct = Math.round((speed - 1) * 100)
  const args = ['--voice', voice, `--rate=${pct >= 0 ? '+' : ''}${pct}%`, '--text', text, '--write-media', out]
  // 网络偶尔抖一下：重试两次
  for (let attempt = 1; ; attempt++) {
    try { await run(bin, args, 60000); return out } catch (e) {
      if (attempt >= 3) throw new Error(`Edge 语音失败（要联网）：${e.message}`)
      await new Promise(r => setTimeout(r, 800 * attempt))
    }
  }
}
