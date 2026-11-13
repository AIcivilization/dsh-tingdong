// lib/ming.js — Mac 本机 Ming 语音（中文配音用）
//
// Ming-3.0-tts-0.5B（inclusionAI，MIT）的 MLX 8 位版，经 mlx-audio 在 Apple 芯片上离线合成，有几十个中文男女声。
// 做法和 dsh-her 的「本机 Ming」一样（同一份锁定依赖、同一个模型版本、同样逐个文件校验）：
//   - 已经装过 dsh-her 的本机 Ming（~/.dsh-her/ming）就直接用它，不再下载；
//   - 没有就装到 ~/.dsh/dsh-tingdong/ming：uv（固定版本、校验过）建 Python 3.12 环境，按锁定文件装 mlx-audio，
//     再下载约 1.6 GB 模型，每个文件核对大小和 SHA-256；下载中断下次接着下。删掉这个文件夹就是卸载。
// 只支持 Apple 芯片、macOS 14 以上。合成时一个常驻的 Python 进程（python/ming_worker.py）占约 2 GB 内存，做完就退出。

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { dataRoot } from './paths.js'

export const MING_WORKER = fileURLToPath(new URL('../python/ming_worker.py', import.meta.url))
const REQUIREMENTS = fileURLToPath(new URL('../python/ming-requirements.txt', import.meta.url))

/** 适合做旁白、对译的内置声音（官方声音表里的一部分）；带「_中性」的是有几种情绪版本的声音 */
export const MING_VOICES = [
  { id: '灵小雅', label: '灵小雅（女 · 甜美，新闻、有声书）', gender: 'f' },
  { id: '灵朵儿', label: '灵朵儿（女 · 温暖知性，纪录片）', gender: 'f' },
  { id: '灵小萌', label: '灵小萌（女 · 清亮，有声书、电台）', gender: 'f' },
  { id: '灵小梨', label: '灵小梨（女 · 轻柔，有声书）', gender: 'f' },
  { id: '灵小柔', label: '灵小柔（女 · 温柔礼貌）', gender: 'f' },
  { id: '灵心恬_中性', label: '灵心恬（女 · 冷静客观，新闻）', gender: 'f' },
  { id: '灵风信_中性', label: '灵风信（女 · 体贴温暖）', gender: 'f' },
  { id: '灵楷', label: '灵楷（男 · 舒缓温暖，纪录片）', gender: 'm' },
  { id: '灵阅川_中性', label: '灵阅川（男 · 浑厚，纪录片、历史）', gender: 'm' },
  { id: '灵小锋', label: '灵小锋（男 · 温和稳重，讲解）', gender: 'm' },
  { id: '灵旭', label: '灵旭（男 · 清亮温柔，有声书）', gender: 'm' },
  { id: '灵江', label: '灵江（男 · 温暖，旁白）', gender: 'm' },
  { id: '灵语尘_中性', label: '灵语尘（男 · 低沉，独白）', gender: 'm' },
]
export const mingVoice = id => MING_VOICES.find(v => v.id === id) || MING_VOICES[0]

/** 模型：固定到一次提交；同样的文件也在 dsh-her 的 GitHub Release 上，先从那里下（Hugging Face 在有些地方很慢） */
const MODEL = {
  repo: 'mlx-community/Ming-3.0-tts-0.5B-8bit',
  revision: 'd0d1da6f627e4b3f20cc2db6ba4aee86d45343ad',
  sources: [
    'https://github.com/AIcivilization/dsh-her/releases/download/ming-model-1/',
    'https://huggingface.co/mlx-community/Ming-3.0-tts-0.5B-8bit/resolve/d0d1da6f627e4b3f20cc2db6ba4aee86d45343ad/',
  ],
  files: [
    { name: 'LICENSE', size: 1067, sha256: '2872f1918dfc04fdeb7f5d66d8d1b773594c9375e7c8f7bda39780bb97ad4fba' },
    { name: 'README.md', size: 4360, sha256: '0af63591f3ab08d8e057330477928692ce8a4234618aacd4f2a0095c5d50bda9' },
    { name: 'added_tokens.json', size: 1785, sha256: '34394b1e16d7da2db16618bd43a0f970902ade0075480bcd812fe62d559ec319' },
    { name: 'campplus.safetensors', size: 27699096, sha256: 'a479586bd8f8f96cdb414eaa2fa07c6cd54d6d1636562e2d75a0211cb3b0a6fd' },
    { name: 'config.json', size: 6087, sha256: '8ea3e685a870fd1a535d3b4a4c975fc20c4fca56e67acdef06fe40004064c73b' },
    { name: 'merges.txt', size: 1671853, sha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5' },
    { name: 'model.safetensors', size: 1573366591, sha256: 'e88a4b53cb5b705703e961389f3d7f0e8b72c240b4dad796bf9961cc018971fc' },
    { name: 'model.safetensors.index.json', size: 201850, sha256: 'f59991abebed1a4f798a9488568af496d925e6eea507450aa8051a06f475a2ce' },
    { name: 'special_tokens_map.json', size: 2726, sha256: '2c2ec51b9da5db654ac20de8310350d0c9c1a65918ae0181b80dacd2919b4fc3' },
    { name: 'tokenizer.json', size: 11431389, sha256: '87d54ca3b44ea2f822ba39a0a45cb1b61644bd6606d9d3536dea75367bffb06d' },
    { name: 'tokenizer_config.json', size: 16260, sha256: '12d6162c815edef24f8606e65b60d43fe0d92b0a4e150a0db8fa01c523aaf36a' },
    { name: 'vocab.json', size: 2776833, sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910' },
  ],
}
const MODEL_BYTES = MODEL.files.reduce((n, f) => n + f.size, 0)

/** uv：固定版本和校验值（只需要 Apple 芯片这一个） */
const UV = { version: '0.11.26', file: 'uv-aarch64-apple-darwin.tar.gz', sha256: '8f7fbf1708399b921857bce71e1d60f0d3ccf52a30caebc1c1a2f175dce13ab6' }

/** 为什么这台电脑用不了；能用就是 undefined */
export function mingUnsupported(platform = process.platform, arch = process.arch, darwin = release()) {
  if (platform !== 'darwin' || arch !== 'arm64') return '本机 Ming 只支持 Apple 芯片的 Mac'
  if (Number.parseInt(darwin, 10) < 23) return '本机 Ming 要 macOS 14 或更新'
  return undefined
}

const ownRoot = () => join(dataRoot(), 'ming')
const pythonOf = root => join(root, 'env', 'bin', 'python3')
const installedAt = root => existsSync(pythonOf(root)) && existsSync(join(root, 'model', '.verified'))

/** 装好的 Ming 在哪：自己装的优先，其次 dsh-her 装的 */
export function findMing() {
  // DSH_TINGDONG_NO_SHARED_MING=1：不用 dsh-her 的（测试自己安装时用）
  const her = process.env.DSH_TINGDONG_NO_SHARED_MING === '1' ? [] : [join(homedir(), '.dsh-her', 'ming'), join(homedir(), '.dsh-her-dev', 'ming')]
  for (const root of [ownRoot(), ...her]) {
    if (installedAt(root)) return { root, python: pythonOf(root), model: join(root, 'model'), shared: root !== ownRoot() }
  }
  return null
}

let installing = null // {step, done?, total?}
let lastError = ''

/** 给界面看的状态 */
export function mingStatus() {
  const why = mingUnsupported()
  if (why) return { supported: false, reason: why, ready: false, voices: MING_VOICES }
  const found = installing ? null : findMing()
  return {
    supported: true,
    ready: Boolean(found),
    shared: Boolean(found && found.shared), // 用的是 dsh-her 装好的
    own: Boolean(found && !found.shared),
    installing: installing ? { ...installing } : null,
    error: installing || found ? '' : lastError,
    voices: MING_VOICES,
  }
}

function run(cmd, args, timeout, env) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 << 20, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n').slice(-2).join(' ')))
      resolve(String(stdout))
    })
  })
}

/** 下载一个文件到 target，大小和 SHA-256 都对才换上 */
async function download(url, target, want, onProgress) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(3600000) })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const hash = createHash('sha256')
  let got = 0
  const meter = new Transform({ transform(c, _e, cb) { hash.update(c); got += c.length; onProgress(got); cb(null, c) } })
  const part = `${target}.part`
  await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(part))
  if (got !== want.size || hash.digest('hex') !== want.sha256) {
    await rm(part, { force: true })
    throw new Error('下载的文件校验不对')
  }
  await rename(part, target)
}

async function installUv(uvHome) {
  const dir = join(uvHome, UV.version)
  const found = [join(dir, 'uv'), join(dir, 'uv-aarch64-apple-darwin', 'uv')].find(p => existsSync(p))
  if (found) return found
  const res = await fetch(`https://github.com/astral-sh/uv/releases/download/${UV.version}/${UV.file}`, { redirect: 'follow', signal: AbortSignal.timeout(300000) })
  if (!res.ok) throw new Error(`下载 uv 失败（${res.status}）`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== UV.sha256) throw new Error('下载的 uv 校验不对，没有使用')
  await mkdir(dir, { recursive: true })
  const archive = join(dir, UV.file)
  await writeFile(archive, bytes)
  await run('tar', ['-xzf', archive, '-C', dir], 120000)
  await rm(archive, { force: true })
  const uv = [join(dir, 'uv'), join(dir, 'uv-aarch64-apple-darwin', 'uv')].find(p => existsSync(p))
  if (!uv) throw new Error('uv 解压后找不到')
  return uv
}

async function downloadModel(dir, onProgress) {
  await mkdir(dir, { recursive: true })
  if (existsSync(join(dir, '.verified'))) return
  const checkedFile = join(dir, '.checked.json')
  let checked = new Set()
  try { checked = new Set(JSON.parse(await readFile(checkedFile, 'utf8'))) } catch { /* 第一次 */ }
  let done = 0
  for (const f of MODEL.files) {
    const target = join(dir, f.name)
    if (checked.has(f.sha256) && existsSync(target) && (await stat(target)).size === f.size) {
      done += f.size
      onProgress(done, MODEL_BYTES)
      continue
    }
    const before = done
    let last = null
    for (const src of MODEL.sources) {
      try {
        await download(src + f.name, target, f, got => onProgress(before + got, MODEL_BYTES))
        last = null
        break
      } catch (e) { last = e }
    }
    if (last) throw new Error(`下载 ${f.name} 失败：${last.message}`)
    done = before + f.size
    checked.add(f.sha256)
    await writeFile(checkedFile, JSON.stringify([...checked]))
  }
  await writeFile(join(dir, '.verified'), `${MODEL.repo}@${MODEL.revision}\n`)
  await rm(checkedFile, { force: true })
}

/** 后台安装（已经在装就什么也不做）。进度看 mingStatus().installing */
export function startMingInstall() {
  const why = mingUnsupported()
  if (why) throw Object.assign(new Error(why), { status: 400 })
  if (installing || findMing()) return
  installing = { step: '准备 Python（第一次约 1 分钟）' }
  lastError = ''
  doInstall().catch(e => { lastError = `安装本机 Ming 失败：${e.message}` }).finally(() => { installing = null })
}

async function doInstall() {
  const root = ownRoot()
  const uvHome = join(dataRoot(), 'uv')
  const env = { UV_PYTHON_INSTALL_DIR: join(uvHome, 'python'), UV_CACHE_DIR: join(uvHome, 'cache'), UV_NO_CONFIG: '1' }
  const uv = await installUv(uvHome)
  if (!existsSync(pythonOf(root))) await run(uv, ['venv', '--quiet', '--python', '3.12', join(root, 'env')], 600000, env)
  installing = { step: '安装语音程序（约 450 MB）' }
  await run(uv, ['pip', 'install', '--quiet', '--require-hashes', '--python', pythonOf(root), '-r', REQUIREMENTS], 1200000, env)
  await rm(env.UV_CACHE_DIR, { recursive: true, force: true }) // 装好了，下载缓存不要了
  await downloadModel(join(root, 'model'), (done, total) => { installing = { step: '下载声音模型（约 1.6 GB）', done, total } })
}

/** 卸载自己装的（dsh-her 的不动） */
export async function uninstallMing() {
  if (installing) throw Object.assign(new Error('正在安装，等装完再卸载'), { status: 409 })
  await rm(ownRoot(), { recursive: true, force: true })
  await rm(join(dataRoot(), 'uv'), { recursive: true, force: true })
}
