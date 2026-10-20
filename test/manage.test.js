// 插件自己的版本检查、更新、卸载
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { compareVersions, createManager } from '../plugin/manage.js'

const root = await mkdtemp(join(tmpdir(), 'tingdong-manage-'))
await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-tingdong', version: '0.3.0' }))
after(() => rm(root, { recursive: true, force: true }))

// 假的 npm：latest 是几就回几
let npmLatest = '0.4.0'
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => (String(url).endsWith('/dsh-tingdong/latest')
  ? new Response(JSON.stringify({ version: npmLatest }), { status: 200 })
  : realFetch(url))
after(() => { globalThis.fetch = realFetch })

const tick = () => new Promise(r => setTimeout(r, 20))

test('版本比较：数字逐位比，预发布版比正式版旧', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  assert.ok(compareVersions('0.3.0', '0.3.0-rc.1') > 0)
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.ok(compareVersions('0.3.0', '0.3.1') < 0)
})

test('有新版本：info 报可以更新，命令带 profile', async () => {
  const m = createManager({ pkgRoot: root, pluginManager: () => ({ installBundle() {}, removeBundle() {} }), profile: () => 'web' })
  await tick()
  const i = await m.info(true)
  assert.equal(i.running, '0.3.0')
  assert.equal(i.latest, '0.4.0')
  assert.equal(i.available, true)
  assert.equal(i.canInstall, true)
  assert.equal(i.command, 'dsh plugin --profile web add dsh-tingdong@0.4.0')
})

test('更新：交给插件管理器装指定版本；成功提示重启', async () => {
  const calls = []
  const m = createManager({ pkgRoot: root, pluginManager: () => ({ async installBundle(spec, o) { calls.push([spec, o]); return { application: 'restart-required' } } }), profile: () => 'desktop' })
  await tick()
  const r = await m.update()
  assert.equal(r.ok, true)
  assert.equal(r.version, '0.4.0')
  assert.match(r.message, /重启/)
  assert.deepEqual(calls, [['dsh-tingdong@0.4.0', { enabled: true }]])
})

test('更新：运行中不能升级 / 出错 / 没有插件管理器，都给出终端命令', async () => {
  const already = createManager({ pkgRoot: root, pluginManager: () => ({ async installBundle() { return { application: 'failed', error: { code: 'already-installed' } } } }), profile: () => 'desktop' })
  const failed = createManager({ pkgRoot: root, pluginManager: () => ({ async installBundle() { return { application: 'failed', error: { code: 'pnpm', diagnostic: 'line1\nERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION' } } } }), profile: () => 'desktop' })
  const none = createManager({ pkgRoot: root, pluginManager: () => undefined, profile: () => undefined })
  await tick()
  const a = await already.update()
  assert.equal(a.ok, false)
  assert.match(a.message, /Cmd\+Q/)
  assert.equal(a.command, 'dsh plugin --profile desktop add dsh-tingdong@0.4.0')
  const f = await failed.update()
  assert.match(f.message, /MINIMUM_RELEASE_AGE/)
  const n = await none.update()
  assert.equal(n.ok, false)
  assert.equal(n.command, 'dsh plugin add dsh-tingdong@0.4.0')
})

test('已是最新时不去装', async () => {
  npmLatest = '0.3.0'
  let called = false
  const m = createManager({ pkgRoot: root, pluginManager: () => ({ async installBundle() { called = true } }), profile: () => 'web' })
  await tick()
  const r = await m.update()
  assert.equal(r.ok, false)
  assert.match(r.message, /已经是最新/)
  assert.equal(called, false)
  npmLatest = '0.4.0'
})

test('卸载：成功说明数据还在；失败给命令', async () => {
  const ok = createManager({ pkgRoot: root, pluginManager: () => ({ async removeBundle(name) { assert.equal(name, 'dsh-tingdong'); return {} } }), profile: () => 'web' })
  const bad = createManager({ pkgRoot: root, pluginManager: () => ({ async removeBundle() { throw new Error('locked') } }), profile: () => 'web' })
  const r = await ok.uninstall()
  assert.equal(r.ok, true)
  assert.match(r.message, /dsh-tingdong/)
  const b = await bad.uninstall()
  assert.equal(b.ok, false)
  assert.equal(b.command, 'dsh plugin --profile web remove dsh-tingdong')
})
