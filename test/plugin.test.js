// 用假的 DSH 宿主（inject / webServer / tools / llm / agentDefaultModel）挂上插件，走一遍接口
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'tingdong-test-'))
process.env.DSH_TINGDONG_HOME = home

const plugin = (await import('../plugin/index.js')).default
const { buildToolDefinitions } = await import('../plugin/tools.js')

const LESSON = {
  id: 'demo-abc123',
  version: 1,
  title: 'Demo',
  titleZh: '示例',
  status: 'ready',
  duration: 12,
  sentences: [
    { i: 0, start: 1, end: 3, text: 'helo world', en: 'Hello world.', zh: '你好，世界。', words: [{ w: 'world', ipa: '/wɝld/', zh: '世界' }], sound: '', skip: false },
    { i: 1, start: 5, end: 6, text: 'yeah', en: 'Yeah.', zh: '', words: [], sound: '', skip: true },
  ],
}

function fakeCtx() {
  const services = {
    webServer: { routes: [], register(r) { this.routes.push(r); return () => {} } },
    tools: { defs: [], register(d) { this.defs.push(d); return () => {} } },
    llm: { async *stream(o) { this.last = o; yield { type: 'text-delta', text: '{"items":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } } } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    // 假的 DSH 信任围栏：带 x-deny 头的请求当成没登录
    connection: { requestRejection: req => (req.headers['x-deny'] ? 401 : undefined) },
  }
  const effects = []
  const ctx = {
    services,
    effects,
    effect(fn) { effects.push(fn()) },
    inject(names, cb) {
      const scope = { effect: fn => { effects.push(fn()) }, get: n => services[n] }
      for (const n of names) scope[n] = services[n]
      cb(scope)
    },
  }
  return ctx
}

let server, base, ctx
before(async () => {
  await mkdir(join(home, 'lessons', LESSON.id), { recursive: true })
  await writeFile(join(home, 'lessons', LESSON.id, 'lesson.json'), JSON.stringify(LESSON))
  await writeFile(join(home, 'lessons', LESSON.id, 'audio.mp3'), Buffer.alloc(1000, 7))
  ctx = fakeCtx()
  plugin.apply(ctx, {})
  await new Promise(r => setTimeout(r, 50)) // 工具注册是异步的
  const route = ctx.services.webServer.routes[0]
  server = createServer((req, res) => route.handler(req, res))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  server && server.close()
  await rm(home, { recursive: true, force: true })
})

test('挂一个前缀路由，注册 4 个工具', () => {
  const routes = ctx.services.webServer.routes
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/api-dsh-tingdong')
  assert.deepEqual(ctx.services.tools.defs.map(d => d.name), ['tingdong_import', 'tingdong_import_text', 'tingdong_lessons', 'tingdong_sentences'])
})

test('没过 DSH 登录校验的请求原样拒绝', async () => {
  const r = await fetch(base + '/api-dsh-tingdong/lessons', { headers: { 'x-deny': '1' } })
  assert.equal(r.status, 401)
})

test('没有 connection 服务时只放行本机', async () => {
  const { isLoopback } = await import('../plugin/index.js')
  assert.ok(isLoopback('127.0.0.1'))
  assert.ok(isLoopback('::ffff:127.0.0.1'))
  assert.ok(isLoopback('::1'))
  assert.ok(!isLoopback('192.168.1.5'))
})

test('status 报告当前模型（来自 DSH 默认模型）', async () => {
  const j = await (await fetch(base + '/api-dsh-tingdong/status')).json()
  assert.equal(j.host, 'dsh')
  assert.equal(j.llm, 'p/m')
  assert.equal(typeof j.ffmpeg, 'boolean')
})

test('面板和 srs.js 能取到', async () => {
  const html = await (await fetch(base + '/api-dsh-tingdong/panel')).text()
  assert.match(html, /<title>听懂<\/title>/)
  const js = await fetch(base + '/api-dsh-tingdong/srs.js')
  assert.match(js.headers.get('content-type'), /javascript/)
})

test('课程列表带进度；单课带句子', async () => {
  const { lessons } = await (await fetch(base + '/api-dsh-tingdong/lessons')).json()
  assert.equal(lessons.length, 1)
  assert.equal(lessons[0].stats.total, 1) // skip 的不算
  const j = await (await fetch(base + `/api-dsh-tingdong/lesson?id=${LESSON.id}`)).json()
  assert.equal(j.lesson.sentences.length, 2)
  const bad = await fetch(base + '/api-dsh-tingdong/lesson?id=../../etc')
  assert.equal(bad.status, 400)
})

test('音频支持 Range', async () => {
  const r = await fetch(base + `/api-dsh-tingdong/audio?id=${LESSON.id}`, { headers: { range: 'bytes=100-199' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/1000')
  assert.equal((await r.arrayBuffer()).byteLength, 100)
})

test('POST 没有 x-tingdong 头一律拒绝（挡 CSRF）', async () => {
  const r = await fetch(base + '/api-dsh-tingdong/grade', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: LESSON.id, i: 0, g: 2 }),
  })
  assert.equal(r.status, 403)
})

test('评分写进进度，工具能找出难句', async () => {
  const post = (p, body) => fetch(base + '/api-dsh-tingdong/' + p, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tingdong': '1' }, body: JSON.stringify(body),
  }).then(r => r.json())
  const g = await post('grade', { id: LESSON.id, i: 0, g: 0 })
  assert.equal(g.card.again, 1)
  const bad = await post('grade', { id: LESSON.id, i: 0, g: 5 })
  assert.ok(bad.error)

  const sentences = ctx.services.tools.defs.find(d => d.name === 'tingdong_sentences')
  const v = await sentences.execute({ id: LESSON.id })
  const text = sentences.output.render({}, v)[0].text
  assert.match(text, /Hello world\./)
  assert.match(text, /没听懂 1 次/)
})

test('导入：不存在的路径给出人话错误', async () => {
  const r = await fetch(base + '/api-dsh-tingdong/import', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tingdong': '1' }, body: JSON.stringify({ path: join(home, 'nope.mp3') }),
  })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /找不到/)
})

test('工具定义能独立构建', async () => {
  const defs = await buildToolDefinitions({ importer: { list: () => [], importPath: async () => [] } })
  const lessons = defs.find(d => d.name === 'tingdong_lessons')
  const v = await lessons.execute({})
  assert.match(lessons.output.render({}, v)[0].text, /示例/)
})
