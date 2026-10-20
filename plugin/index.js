// plugin/index.js — 听懂（dsh-tingdong）的 DSH 插件（宿主端）
//
// 1. 把学习面板和接口挂到 dsh 自己的 webServer 上：/api-dsh-tingdong/*
//    插件路由不会自动过 dsh 的登录校验：每个请求先问 connection.requestRejection()（和官方 open-in-app 一样：
//    Host/Origin 防 DNS 重绑定和跨站，再查登录令牌 cookie）；老版本没有这个服务就只放行本机
// 2. 翻译讲解用 DSH 里配好的模型（ctx.llm）：插件配置里的 provider/model，没有就用 DSH 的默认模型
// 3. 注册 AI 工具（plugin/tools.js）：在对话里导入音频、查进度、找出总听不懂的句子来讲
//
// 识别在子进程里跑（lib/asr-worker.js），不卡 DSH。
//
// 可选配置（profile 的 cordis.patch.yml 里给 id: dsh-tingdong 加 config）：
//   provider / model   翻译用的模型（两个都填才生效）
//   ffmpeg             ffmpeg 的完整路径（找不到时填）
//   threads            识别线程数，默认 2
//   concurrency        同时翻译几批，默认 3

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Importer } from '../lib/importer.js'
import { dshLlm } from '../lib/llm.js'
import { createHandler } from '../lib/server.js'
import { registerTools } from './tools.js'
import { createManager } from './manage.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const PREFIX = '/api-dsh-tingdong'

export const name = 'dsh-tingdong'
export const inject = []

/** Web Worker 隧道里的请求没有 socket（本机页面发的），也算本机 */
export function isLoopback(ip) {
  if (ip === undefined || ip === null) return true
  return /^(127\.|::1$|::ffff:127\.)/.test(String(ip))
}

async function readPkgJson() {
  try { return JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8')) } catch { return {} }
}

export function apply(ctx, config = {}) {
  const cfg = config || {}
  let llm
  let defaults
  let version = ''
  readPkgJson().then(p => { version = p.version || '' })

  // 每次翻译时取当前模型：配置优先，否则 DSH 的默认模型（用户在 DSH 里换了模型就跟着换）
  const route = () => {
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    try {
      const sel = defaults && defaults.currentSelection()
      return sel && sel.provider && sel.model ? { provider: sel.provider, model: sel.model } : null
    } catch { return null }
  }

  ctx.inject(['llm'], (c) => {
    c.effect(() => {
      llm = c.llm || (c.get && c.get('llm'))
      return () => { llm = undefined }
    })
  })
  ctx.inject(['agentDefaultModel'], (c) => {
    c.effect(() => {
      defaults = c.agentDefaultModel || (c.get && c.get('agentDefaultModel'))
      return () => { defaults = undefined }
    })
  })

  const importer = new Importer({
    llm: () => (llm && typeof llm.stream === 'function' && route() ? dshLlm(llm, route) : null),
    options: () => ({ ffmpeg: cfg.ffmpeg, threads: cfg.threads || 2, concurrency: cfg.concurrency || 3 }),
    log: (m) => { try { ctx.logger ? ctx.logger.warn(m) : console.warn(m) } catch { /* 忽略 */ } },
  })
  // 插件卸载 / DSH 退出：停掉正在跑的识别子进程
  const stopAll = () => { for (const j of importer.jobs) importer.cancel(j.id) }
  if (typeof ctx.effect === 'function') ctx.effect(() => stopAll)
  else if (typeof ctx.on === 'function') ctx.on('dispose', stopAll)

  // DSH 自己的插件管理器（更新 / 卸载按钮用；老版本 DSH 没有）
  let pluginManager
  ctx.inject(['pluginManager'], (c) => {
    c.effect(() => {
      pluginManager = c.pluginManager || (c.get && c.get('pluginManager'))
      return () => { pluginManager = undefined }
    })
  })
  let profile
  try { profile = ctx.get && ctx.get('profileContext') && ctx.get('profileContext').name } catch { profile = undefined }
  const manage = createManager({ pkgRoot: PKG_ROOT, pluginManager: () => pluginManager, profile: () => profile })

  const handle = createHandler({
    manage,
    prefix: PREFIX,
    pkgRoot: PKG_ROOT,
    importer,
    options: () => ({ ffmpeg: cfg.ffmpeg }),
    status: () => {
      const r = route()
      return { host: 'dsh', version, llm: llm && r ? `${r.provider}/${r.model}` : '' }
    },
  })

  let connection
  ctx.inject(['connection'], (c) => {
    c.effect(() => {
      connection = c.connection || (c.get && c.get('connection'))
      return () => { connection = undefined }
    })
  })
  /** 不放行就直接回状态码，返回 true */
  const rejected = (req, res) => {
    let code
    if (connection && typeof connection.requestRejection === 'function') code = connection.requestRejection(req)
    else if (!isLoopback(req.socket && req.socket.remoteAddress)) code = 403
    if (code === undefined) return false
    res.statusCode = code
    res.end()
    return true
  }
  const guarded = (req, res) => (rejected(req, res) ? undefined : handle(req, res))

  ctx.inject(['webServer'], (c) => {
    const ws = c.webServer || (c.get && c.get('webServer'))
    if (!ws || typeof ws.register !== 'function') return
    const reg = () => ws.register({ kind: 'prefix', path: PREFIX, handler: guarded })
    if (typeof c.effect === 'function') c.effect(reg)
    else reg()
  })

  ctx.inject(['tools'], (c) => {
    const tools = c.tools || (c.get && c.get('tools'))
    if (!tools || typeof tools.register !== 'function') return
    registerTools(tools, { importer, effect: typeof c.effect === 'function' ? fn => c.effect(fn) : null })
      .catch(e => console.warn('[dsh-tingdong] AI 工具注册失败', e))
  })
}

export default { name, inject, apply, __meta: { pkgRoot: PKG_ROOT } }
