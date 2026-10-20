// lib/vps.js — 把电脑上做好的课发到 VPS 上的 DSH（手机打开 VPS 学）
//
// 走 SSH，不走网页：VPS 上的 DSH 通常有登录门（如 dsh-vps 的 dsh-gate），机器之间不好过；
// 而电脑本来就能用 SSH 钥匙登录 VPS（~/.ssh/config 里配好的主机）。
// 课程文件夹打成 tar 流经 SSH 解到 VPS 上那个 DSH 用户的 ~/.dsh/dsh-tingdong/lessons/：
// 只发内容（句子、翻译、音频、声音轨），不发 progress.json——VPS 上的学习进度不会被覆盖。

import { spawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { dataRoot, lessonsDir } from './paths.js'
import { checkId } from './store.js'

const cfgPath = () => join(dataRoot(), 'vps.json')
const SAFE = /^[A-Za-z0-9_.\/-]+$/
const HOST_RE = /^[A-Za-z0-9_.@:-]+$/

export async function getVpsConfig() {
  try { return JSON.parse(await readFile(cfgPath(), 'utf8')) } catch { return null }
}

export async function saveVpsConfig(c) {
  if (!HOST_RE.test(String(c.host || ''))) throw Object.assign(new Error('SSH 主机名不对'), { status: 400 })
  if (!SAFE.test(String(c.home || '')) || !/^[a-z_][a-z0-9_-]*$/i.test(String(c.user || ''))) throw Object.assign(new Error('VPS 上的 DSH 信息不对'), { status: 400 })
  const cfg = { host: c.host, user: c.user, home: c.home, domain: String(c.domain || '').slice(0, 200), port: Number(c.port) || null, savedAt: Date.now() }
  await mkdir(dataRoot(), { recursive: true })
  await writeFile(cfgPath(), JSON.stringify(cfg, null, 1))
  return cfg
}

/** ~/.ssh/config（含 Include 的文件）里的主机名，去掉通配 */
export async function sshHosts() {
  const seen = new Set()
  const out = []
  const read = async (file, depth) => {
    let text = ''
    try { text = await readFile(file, 'utf8') } catch { return }
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*/, '').trim()
      const m = /^(Host|Include)\s+(.+)$/i.exec(line)
      if (!m) continue
      if (m[1].toLowerCase() === 'include' && depth < 2) {
        for (const pat of m[2].split(/\s+/)) {
          const p = pat.replace(/^~/, homedir())
          const full = p.startsWith('/') ? p : join(homedir(), '.ssh', p)
          if (full.includes('*')) {
            const dir = full.slice(0, full.lastIndexOf('/'))
            try { for (const f of await readdir(dir)) await read(join(dir, f), depth + 1) } catch { /* 没有 */ }
          } else await read(full, depth + 1)
        }
      } else if (m[1].toLowerCase() === 'host') {
        for (const h of m[2].split(/\s+/)) {
          if (!h || /[*?!]/.test(h) || seen.has(h)) continue
          seen.add(h)
          out.push(h)
        }
      }
    }
  }
  await read(join(homedir(), '.ssh', 'config'), 0)
  return out
}

function sshBin() {
  return ['/usr/bin/ssh', 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'].find(p => existsSync(p)) || 'ssh'
}
function tarBin() {
  return ['/usr/bin/tar', 'C:\\Windows\\System32\\tar.exe'].find(p => existsSync(p)) || 'tar'
}
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15']

function ssh(host, script, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(sshBin(), [...SSH_OPTS, host, script], { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message).trim().split('\n').slice(-2).join(' ')
        return reject(Object.assign(new Error(/Permission denied|publickey/i.test(msg)
          ? `SSH 登录 ${host} 被拒绝：这台电脑要能用钥匙免密码登录（dsh-vps-manager 添加机器时会自动配好）`
          : `连不上 ${host}：${msg}`), { status: 400 }))
      }
      resolve(String(stdout))
    })
  })
}

/**
 * 登上 VPS，找出正在跑的 DSH 网页版（dsh web），各是哪个用户、家目录、端口、域名
 * @returns {Promise<{sshUser:string, root:boolean, instances:{user,home,port,domain,hasPlugin:boolean}[]}>}
 */
export async function detect(host) {
  if (!HOST_RE.test(String(host || ''))) throw Object.assign(new Error('SSH 主机名不对'), { status: 400 })
  const script = [
    'id -un; id -u; echo ---',
    "ps -eo user=,args= | grep -E 'bin\\.js web|dsh web' | grep -v grep; echo ---",
    "for u in $(ps -eo user=,args= | grep -E 'bin\\.js web|dsh web' | grep -v grep | awk '{print $1}' | sort -u); do",
    '  h=$(getent passwd "$u" | cut -d: -f6); p=no; ls -d "$h"/.dsh/profiles/*/node_modules/dsh-tingdong >/dev/null 2>&1 && p=yes; echo "$u $h $p"; done',
  ].join('\n')
  const out = await ssh(host, script)
  const [who, procs = '', homes = ''] = out.split('---\n')
  const [sshUser, uid] = who.trim().split('\n')
  const homeOf = new Map(homes.trim().split('\n').filter(Boolean).map(l => { const [u, h, p] = l.split(' '); return [u, { home: h, hasPlugin: p === 'yes' }] }))
  const instances = []
  for (const line of procs.trim().split('\n').filter(Boolean)) {
    const user = line.split(/\s+/)[0]
    const port = Number((/--port[ =](\d+)/.exec(line) || [])[1]) || null
    const domain = ((/--trusted-host[ =](\S+)/.exec(line) || /--public-url[ =]https?:\/\/([^/\s]+)/.exec(line) || [])[1]) || ''
    const h = homeOf.get(user)
    if (!h || !SAFE.test(h.home)) continue
    instances.push({ user, home: h.home, port, domain, hasPlugin: h.hasPlugin })
  }
  return { sshUser, root: uid === '0', instances }
}

async function dirSize(dir) {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(p)
    else if (!/^progress\.json$|\.part\.mp3$|^drill-/.test(e.name)) total += (await stat(p)).size
  }
  return total
}

/**
 * 发一课到 VPS
 * @param {object} cfg getVpsConfig() 的结果
 * @param {string} id 课程
 * @param {{onProgress?(sent:number,total:number):void, signal?:AbortSignal}} o
 */
export async function sendLesson(cfg, id, o = {}) {
  checkId(id)
  if (!cfg || !HOST_RE.test(cfg.host) || !SAFE.test(cfg.home)) throw new Error('还没设置 VPS：在课程库页面的「手机学习（VPS）」里先选主机')
  const total = await dirSize(join(lessonsDir(), id))
  const dest = `${cfg.home}/.dsh/dsh-tingdong/lessons`
  // root 登录时把文件交给 DSH 的用户；本来就是那个用户就不用改
  const own = `if [ "$(id -u)" = 0 ]; then chown -R ${cfg.user}:${cfg.user} '${cfg.home}/.dsh/dsh-tingdong'; fi`
  const remote = `set -e; mkdir -p '${dest}'; tar -C '${dest}' -xf - 2>/tmp/tingdong-tar.err || { cat /tmp/tingdong-tar.err >&2; exit 1; }; ${own}`
  const tarArgs = ['-C', lessonsDir(), '-cf', '-', '--exclude=progress.json', '--exclude=*.part.mp3', '--exclude=drill-*']
  if (process.platform === 'darwin') tarArgs.push('--no-mac-metadata')
  tarArgs.push(id)
  return new Promise((resolve, reject) => {
    const tar = spawn(tarBin(), tarArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const sh = spawn(sshBin(), [...SSH_OPTS, cfg.host, remote], { stdio: ['pipe', 'ignore', 'pipe'] })
    let sent = 0
    let err = ''
    const meter = new Transform({
      transform(c, _e, cb) { sent += c.length; o.onProgress && o.onProgress(Math.min(sent, total), total); cb(null, c) },
    })
    tar.stdout.pipe(meter).pipe(sh.stdin)
    tar.stderr.on('data', d => { err = (err + d).slice(-2000) })
    sh.stderr.on('data', d => { err = (err + d).slice(-2000) })
    const kill = () => { tar.kill('SIGKILL'); sh.kill('SIGKILL') }
    if (o.signal) o.signal.addEventListener('abort', kill, { once: true })
    let tarCode = null
    tar.on('close', c => { tarCode = c })
    tar.on('error', reject)
    sh.on('error', reject)
    sh.on('close', code => {
      if (o.signal) o.signal.removeEventListener('abort', kill)
      if (o.signal && o.signal.aborted) return reject(new Error('已取消'))
      if (code !== 0 || (tarCode !== null && tarCode !== 0)) return reject(new Error(`发送失败：${err.trim().split('\n').slice(-2).join(' ') || `ssh 退出 ${code}`}`))
      resolve({ bytes: sent })
    })
  })
}

/** 手机上打开的地址 */
export function panelUrl(cfg) {
  return cfg && cfg.domain ? `https://${cfg.domain}/api-dsh-tingdong/panel` : ''
}
