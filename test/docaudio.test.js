// 文档转音频：整篇文档的几课按顺序接成一个 MP3（章间 1.5 秒静音），缓存，没做完给提示
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'tingdong-docaudio-'))
process.env.DSH_TINGDONG_HOME = home
after(() => rm(home, { recursive: true, force: true }))

const { createEncoder, RATE } = await import('../lib/pcm.js')
const { findFfmpeg } = await import('../lib/paths.js')
const store = await import('../lib/store.js')
const { wholeDocAudio } = await import('../lib/docaudio.js')

const ffmpeg = findFfmpeg()
const DOC = 'abcdef123456'

async function lesson(id, order, seconds) {
  await store.saveLesson({ id, kind: 'doc', title: id, group: '测试文档', order, status: 'ready', voiceLabel: 'Edge Andrew', duration: seconds, source: { type: 'doc', docId: DOC }, sentences: [{ i: 0, start: 0, end: seconds, text: 'Hi.', en: 'Hi.' }] })
  if (seconds) {
    const enc = createEncoder({ ffmpeg, out: store.audioPath(id), gap: 0 })
    await enc.write(0, new Float32Array(Math.round(RATE * seconds)).fill(0.05))
    await enc.finish()
  }
}
const dur = f => Number((/Duration: (\d+):(\d+):([\d.]+)/.exec(spawnSync(ffmpeg, ['-hide_banner', '-i', f], { encoding: 'utf8' }).stderr) || []).slice(1).reduce((t, x, k) => t + Number(x) * [3600, 60, 1][k], 0))

test('几课按顺序接成一个 MP3，章间 1.5 秒；第二次直接用缓存', { skip: !ffmpeg && '没有 ffmpeg' }, async () => {
  await lesson('ch-two-0000aa', 1, 3)
  await lesson('ch-one-0000aa', 0, 2)
  const a = await wholeDocAudio(DOC)
  assert.equal(a.lessons, 2)
  assert.equal(a.title, '测试文档')
  assert.equal(a.voiceLabel, 'Edge Andrew')
  // 每课各带 0.5 秒结尾静音：2.5 + 1.5 + 3.5 = 7.5 秒；
  // 不重新编码直接拼，每个 MP3 自带的编码延迟（约 60 毫秒）会留下来，3 段多出不到 0.3 秒
  assert.ok(dur(a.file) >= 7.45 && dur(a.file) < 7.8, `总长 ${dur(a.file)}`)
  const again = await wholeDocAudio(DOC)
  assert.equal(again.file, a.file)
})

test('还有课没转完：给出人话提示；只有一课时直接给那一课的音频', { skip: !ffmpeg && '没有 ffmpeg' }, async () => {
  await lesson('ch-three-0000aa', 2, 0)
  await assert.rejects(wholeDocAudio(DOC), /还有 1 课没朗读完/)
  await assert.rejects(wholeDocAudio('nope'), /文档编号不对/)
  await assert.rejects(wholeDocAudio('000000000000'), /没有这份文档/)
  // 只有一课的文档：不用拼，直接给那一课的朗读
  await store.saveLesson({ id: 'solo-0000bb', kind: 'doc', title: 'Solo', group: '单课', order: 0, status: 'ready', duration: 1, source: { type: 'doc', docId: 'bbbbbb123456' }, sentences: [{ i: 0, start: 0, end: 1, text: 'Hi.' }] })
  const enc = createEncoder({ ffmpeg, out: store.audioPath('solo-0000bb'), gap: 0 })
  await enc.write(0, new Float32Array(RATE).fill(0.05))
  await enc.finish()
  const solo = await wholeDocAudio('bbbbbb123456')
  assert.equal(solo.file, store.audioPath('solo-0000bb'))
  assert.equal(solo.lessons, 1)
})
