// plugin/manage.js — 插件自己的版本、更新、卸载（首页标题旁的按钮）
//
// 更新、卸载交给 DSH 自己的插件管理器（pluginManager.installBundle / removeBundle，和 DSH「插件」页同一套：
// 带锁跑 pnpm、失败自动还原）。写法照 dsh-pick。拿不到插件管理器（老版本 DSH）或它拒绝时，
// 给出用户可以自己在终端执行的命令。装完要重启 DSH 才生效。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PACKAGE = 'dsh-tingdong'
// npm 官方源连不上（国内常见）就问镜像
const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** a 比 b 新返回正数（x.y.z，预发布版比同号正式版旧） */
export function compareVersions(a, b) {
  const parse = v => {
    const [core, pre = ''] = String(v || '').replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map(n => parseInt(n, 10) || 0), pre }
  }
  const x = parse(a), y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0)
    if (d) return d
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

/** 插件管理器的失败结果 → 错误码 / 一行人话 */
function managerCode(result) {
  if (!(result && (result.application === 'failed' || result.application === 'cancelled' || result.error))) return ''
  return (result.error && result.error.code) || result.application || 'failed'
}
function managerError(result) {
  const code = managerCode(result)
  if (!code) return ''
  const detail = String((result.error && result.error.diagnostic) || (result.packageResult && result.packageResult.output) || '')
    .trim().split('\n').slice(-3).join(' ').slice(-300)
  return detail ? `${code}：${detail}` : code
}

const RESTART = 'DSH 要重启才用上新版本：电脑上完全退出 DSH（Mac 按 Cmd+Q，不是关窗口）再打开；VPS 上在「设置 → VPS 部署」里重启。'
const ALREADY = '这个版本的 DSH 不能在运行中升级已装的插件。完全退出 DSH（Mac 上按 Cmd+Q）后在终端执行下面的命令，再打开 DSH。'

/**
 * @param {object} o
 * @param {string} o.pkgRoot 本包根目录
 * @param {() => any} o.pluginManager 拿 DSH 的插件管理器（可能没有）
 * @param {() => string|undefined} o.profile 当前 profile 名（拼命令用）
 */
export function createManager(o) {
  let running = ''
  const readPkg = async () => { try { return JSON.parse(await readFile(join(o.pkgRoot, 'package.json'), 'utf8')) } catch { return {} } }
  // 初始包信息读取：info()/update() 开先 await 它，避免 running 还没读到就比版本
  const pkgReady = readPkg().then(p => { running = p.version || '' })

  let cache = null
  async function latest(force) {
    if (!force && cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.version
    for (const r of REGISTRIES) {
      try {
        const res = await fetch(`${r}/${PACKAGE}/latest`, { signal: AbortSignal.timeout(6000) })
        if (!res.ok) continue
        const { version } = await res.json()
        if (VERSION_RE.test(String(version || ''))) { cache = { version, at: Date.now() }; return version }
      } catch { /* 换下一个源 */ }
    }
    return ''
  }

  const command = args => {
    const p = o.profile()
    return /^[A-Za-z0-9._-]+$/.test(p || '') ? `dsh plugin --profile ${p} ${args}` : `dsh plugin ${args}`
  }
  const pm = () => { try { return o.pluginManager() } catch { return null } }

  return {
    /** 版本信息：正在运行的、磁盘上装好的、npm 上最新的 */
    async info(force) {
      await pkgReady
      const [pkg, newest] = await Promise.all([readPkg(), latest(force)])
      const installed = pkg.version || ''
      const current = compareVersions(installed, running) > 0 ? installed : running
      const m = pm()
      return {
        running,
        restartPending: installed && running && compareVersions(installed, running) > 0 ? installed : '',
        latest: newest,
        available: Boolean(newest) && compareVersions(newest, current) > 0,
        canInstall: Boolean(m && typeof m.installBundle === 'function'),
        canRemove: Boolean(m && typeof m.removeBundle === 'function'),
        command: command(`add ${PACKAGE}@${newest || 'latest'}`),
        removeCommand: command(`remove ${PACKAGE}`),
        restartHint: RESTART,
      }
    },
    async update() {
      await pkgReady
      const newest = await latest(true)
      const cmd = command(`add ${PACKAGE}@${newest || 'latest'}`)
      if (!newest) return { ok: false, message: '查不到 npm 上的最新版本，检查网络后再试', command: cmd }
      if (compareVersions(newest, running) <= 0) return { ok: false, message: `已经是最新版 v${running}` }
      const m = pm()
      if (!m || typeof m.installBundle !== 'function') return { ok: false, message: '这个版本的 DSH 不能在这里装插件，请在终端执行命令', command: cmd }
      try {
        const result = await m.installBundle(`${PACKAGE}@${newest}`, { enabled: true })
        if (managerCode(result) === 'already-installed') return { ok: false, message: ALREADY, command: cmd }
        const err = managerError(result)
        if (err) return { ok: false, message: `更新失败（${err}）`, command: cmd }
        return { ok: true, version: newest, message: RESTART }
      } catch (e) {
        if (e && e.code === 'already-installed') return { ok: false, message: ALREADY, command: cmd }
        return { ok: false, message: `更新失败：${e.message}`, command: cmd }
      }
    },
    async uninstall() {
      const cmd = command(`remove ${PACKAGE}`)
      const m = pm()
      if (!m || typeof m.removeBundle !== 'function') return { ok: false, message: '这里没法直接卸载：完全退出 DSH 后在终端执行命令', command: cmd }
      try {
        const err = managerError(await m.removeBundle(PACKAGE))
        if (err) return { ok: false, message: `卸载失败（${err}），可完全退出 DSH 后在终端执行命令`, command: cmd }
        return { ok: true, message: '已卸载，重启 DSH 后彻底移除。课程和学习进度还留在 ~/.dsh/dsh-tingdong，重新装上就回来。' }
      } catch (e) {
        return { ok: false, message: `卸载失败：${e.message}`, command: cmd }
      }
    },
  }
}
