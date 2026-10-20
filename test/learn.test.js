// 学习功能：今日学习、进度同步、收藏、改句子、磨耳朵、听写对答案、SSH 主机列表
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'tingdong-learn-'))
process.env.DSH_TINGDONG_HOME = home
after(() => rm(home, { recursive: true, force: true }))

const store = await import('../lib/store.js')
const { today, dayKey, streakOf, minutesOf } = await import('../lib/today.js')
const { buildDrill, pickSentences } = await import('../lib/drill.js')
const { dictationDiff } = await import('../web/dict.js')
const { findFfmpeg } = await import('../lib/paths.js')

const sentences = n => Array.from({ length: n }, (_, i) => ({ i, start: 1 + i * 4, end: 3 + i * 4, text: `w${i} one two`, en: `W${i} one two.`, zh: `句${i}`, words: [], sound: '', skip: false }))

async function makeLesson(id, n = 5, extra = {}) {
  await store.saveLesson({ id, version: 1, title: id, status: 'ready', duration: n * 4 + 2, sentences: sentences(n), ...extra })
}

test('dayKey 按用户时区：UTC 23:30 在北京已经是第二天', () => {
  const ts = Date.parse('2026-10-19T23:30:00Z')
  assert.equal(dayKey(ts, 0), '2026-10-19')
  assert.equal(dayKey(ts, -480), '2026-10-20')
})

test('连续天数：今天没学、昨天学了不算断', () => {
  assert.equal(streakOf(['2026-10-18', '2026-10-19', '2026-10-20'], '2026-10-20'), 3)
  assert.equal(streakOf(['2026-10-18', '2026-10-19'], '2026-10-20'), 2)
  assert.equal(streakOf(['2026-10-17'], '2026-10-20'), 0)
})

test('学习分钟：中途休息超过 3 分钟只记 3 分钟', () => {
  const t = 1_000_000
  assert.equal(minutesOf([]), 0)
  assert.equal(minutesOf([t, t + 60_000, t + 60 * 60_000]), 5) // 0.5 + 1 + 3 ≈ 4.5 → 5
})

test('今日学习：所有课里到期的先来，再按「学到哪了」补新句子', async () => {
  await makeLesson('ta-111111', 5)
  await makeLesson('tb-222222', 5)
  const now = Date.now()
  await store.gradeSentence('ta-111111', 0, 0) // 一分钟后到期
  await store.setProgressFields('tb-222222', { pos: 3 })
  const t = await today({ now: now + 5 * 60_000, newPerDay: 4, tz: 0 })
  assert.equal(t.dueCount, 1)
  assert.deepEqual(t.queue[0], { id: 'ta-111111', i: 0, title: 'ta-111111' })
  assert.equal(t.newToday, 1)
  assert.equal(t.newCount, 3) // 每天 4 句新句子，今天已经学了 1 句
  assert.equal(t.todayCount, 1)
  assert.equal(t.streak, 1)
  assert.equal(t.week.length, 7)
})

test('进度：位置和声音存服务器；重置时收藏保留', async () => {
  await makeLesson('tc-333333', 4)
  assert.deepEqual(await store.setProgressFields('tc-333333', { pos: 2, track: 'kokoro' }), { pos: 2, track: 'kokoro' })
  await store.setProgressFields('tc-333333', { pos: -1, track: '../x' }) // 不合法的不收
  const p = await store.getProgress('tc-333333')
  assert.equal(p.pos, 2)
  assert.equal(p.track, 'kokoro')
  assert.deepEqual(await store.setStar('tc-333333', 3, true), [3])
  assert.deepEqual(await store.setStar('tc-333333', 1, true), [1, 3])
  assert.deepEqual(await store.setStar('tc-333333', 3, false), [1])
  await store.gradeSentence('tc-333333', 1, 2)
  await store.resetProgress('tc-333333')
  const r = await store.getProgress('tc-333333')
  assert.deepEqual(r.cards, {})
  assert.deepEqual(r.stars, [1])
  assert.equal(r.track, 'kokoro')
})

test('改句子：改字、合并、拆开，都记 editedAt', async () => {
  await makeLesson('td-444444', 3)
  const s = await store.editSentence('td-444444', 0, { en: 'Fixed text here.', zh: '改过' })
  assert.equal(s.en, 'Fixed text here.')
  await assert.rejects(store.editSentence('td-444444', 0, { en: '  ' }), /不能为空/)
  const m = await store.mergeWithNext('td-444444', 0)
  assert.equal(m.en, 'Fixed text here. W1 one two.')
  assert.equal(m.end, 7)
  assert.equal(m.zh, '改过句1')
  let l = await store.getLesson('td-444444')
  assert.equal(l.sentences.length, 2)
  assert.ok(l.editedAt)
  await assert.rejects(store.mergeWithNext('td-444444', 2), /最后一句/)
  const [a, b] = await store.splitSentence('td-444444', 0, 3)
  assert.equal(a.en, 'Fixed text here.')
  assert.equal(b.en, 'W1 one two.')
  assert.equal(b.i, 3) // 新编号接在最大的后面
  assert.ok(a.end === b.start && b.start > 1 && b.start < 7)
  assert.equal(a.zh, '')
  l = await store.getLesson('td-444444')
  assert.deepEqual(l.sentences.map(x => x.i), [0, 3, 2])
  await assert.rejects(store.splitSentence('td-444444', 0, 0), /拆分位置/)
})

test('磨耳朵挑句子：全部 / 从第几句 / 难句 / 收藏 / 到期', () => {
  const l = { sentences: sentences(5) }
  l.sentences[4].skip = true
  const now = 1000
  const p = { cards: { 1: { again: 1, lastGrade: 2, due: 500 }, 2: { again: 0, lastGrade: 2, due: 5000 } }, stars: [3] }
  assert.deepEqual(pickSentences(l, p, { scope: 'all' }).map(s => s.i), [0, 1, 2, 3])
  assert.deepEqual(pickSentences(l, p, { scope: 'all', from: 2 }).map(s => s.i), [2, 3])
  assert.deepEqual(pickSentences(l, p, { scope: 'hard' }).map(s => s.i), [1])
  assert.deepEqual(pickSentences(l, p, { scope: 'star' }).map(s => s.i), [3])
  assert.deepEqual(pickSentences(l, p, { scope: 'due', now }).map(s => s.i), [1])
})

const ffmpeg = findFfmpeg()
test('磨耳朵音频：每句放几遍 + 想的停顿，时间表连续；同样设置走缓存', { skip: !ffmpeg && '没有 ffmpeg' }, async () => {
  const id = 'te-555555'
  await makeLesson(id, 3)
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=14', '-ac', '1', '-b:a', '64k', join(home, 'lessons', id, 'audio.mp3')])
  assert.equal(r.status, 0)
  const l = await store.getLesson(id)
  const d = await buildDrill(l, { cards: {} }, { track: 'full', repeat: 2, pause: 2 })
  assert.equal(d.items.length, 3)
  const it = d.items[0]
  assert.equal(it.reps.length, 2)
  assert.ok(Math.abs(it.reps[1][0] - it.reps[0][1] - 0.8) < 0.01, '两遍之间停 0.8 秒')
  assert.ok(Math.abs(it.think[1] - it.think[0] - 2.4) < 0.01, '想的时间 2 秒 + 0.4')
  assert.ok(Math.abs(d.items[1].reps[0][0] - it.think[1]) < 0.01, '下一句紧接着开始')
  assert.equal(d.cached, false)
  const again = await buildDrill(l, { cards: {} }, { track: 'full', repeat: 2, pause: 2 })
  assert.equal(again.cached, true)
  assert.equal(again.name, d.name)
  await assert.rejects(buildDrill(l, { cards: {} }, { scope: 'star' }), /没有「收藏」/)
})

test('听写对答案：忽略大小写标点，数字和英文数字等价，标出漏掉的词', () => {
  const r = dictationDiff('Then go on to Focus 10, and I will join you there.', 'then go on to focus ten and I join you there')
  assert.deepEqual(r.words.filter(w => !w.ok).map(w => w.w), ['will'])
  assert.ok(Math.abs(r.score - 11 / 12) < 1e-9)
  assert.equal(dictationDiff('Hello world.', '').score, 0)
  assert.equal(dictationDiff('Hello world.', 'hello world extra').extra, 1)
})

test('SSH 主机列表：读 ~/.ssh/config 和 Include，去掉通配', async () => {
  const fake = join(home, 'fakehome')
  await mkdir(join(fake, '.ssh', 'config.d'), { recursive: true })
  await writeFile(join(fake, '.ssh', 'config'), 'Include config.d/*\nHost vps  # 注释\n  HostName 1.2.3.4\nHost *\n  User x\nHost a b\n')
  await writeFile(join(fake, '.ssh', 'config.d', 'extra'), 'Host lab\n')
  const old = process.env.HOME
  process.env.HOME = fake
  try {
    const { sshHosts } = await import('../lib/vps.js')
    assert.deepEqual(await sshHosts(), ['lab', 'vps', 'a', 'b'])
  } finally {
    process.env.HOME = old
  }
})
