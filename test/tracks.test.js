// 声音轨：WAV 解析、去静音、原声去空白的截取和时间表
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'tingdong-tracks-'))
process.env.DSH_TINGDONG_HOME = home
after(() => rm(home, { recursive: true, force: true }))

const { parseWav, trimSilence, RATE } = await import('../lib/pcm.js')
const { buildTrack, listTracks } = await import('../lib/tracks.js')
const { findFfmpeg } = await import('../lib/paths.js')

function wav(samples, { rate = RATE, float = true, junk = false } = {}) {
  const bytes = float ? 4 : 2
  const extra = junk ? 12 : 0
  const b = Buffer.alloc(44 + extra + samples.length * bytes)
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(float ? 3 : 1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * bytes, 28); b.writeUInt16LE(bytes, 32); b.writeUInt16LE(bytes * 8, 34)
  let off = 36
  if (junk) { b.write('FLLR', off); b.writeUInt32LE(4, off + 4); off += 12 }
  b.write('data', off); b.writeUInt32LE(samples.length * bytes, off + 4)
  samples.forEach((v, k) => (float ? b.writeFloatLE(v, off + 8 + k * 4) : b.writeInt16LE(Math.round(v * 32767), off + 8 + k * 2)))
  return b
}

test('parseWav：float32、int16、中间夹填充块（macOS say）都能读', () => {
  const f = parseWav(wav([0, 0.5, -0.5], { junk: true }))
  assert.equal(f.rate, RATE)
  assert.deepEqual([...f.samples], [0, 0.5, -0.5])
  const i = parseWav(wav([0, 0.5], { float: false }))
  assert.ok(Math.abs(i.samples[1] - 0.5) < 0.001)
  assert.throws(() => parseWav(Buffer.from('nope')))
})

test('trimSilence：切掉首尾静音，留一点余量', () => {
  const s = new Float32Array(RATE * 2)
  s.fill(0.2, RATE * 0.5, RATE * 1.5)
  const t = trimSilence(s, RATE, 0.05)
  assert.ok(Math.abs(t.length / RATE - 1.1) < 0.01)
})

const ffmpeg = findFfmpeg()
test('原声·去空白：只留讲话，句间固定停顿，时间表对得上', { skip: !ffmpeg && '没有 ffmpeg' }, async () => {
  const id = 'synthetic-abc123'
  const dir = join(home, 'lessons', id)
  await mkdir(dir, { recursive: true })
  // 合成 20 秒：3–5 秒、10–13 秒、16–17 秒有「讲话」（正弦波），其余是静音
  const expr = "if(between(t,3,5)+between(t,10,13)+between(t,16,17),0.5*sin(2*PI*440*t),0)"
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=20`, '-ac', '1', '-b:a', '64k', join(dir, 'audio.mp3')])
  assert.equal(r.status, 0, String(r.stderr))
  const lesson = {
    id,
    sentences: [
      { i: 0, start: 3, end: 5, text: 'a' },
      { i: 1, start: 7, end: 7.5, text: 'noise', skip: true },
      { i: 2, start: 10, end: 13, text: 'b' },
      { i: 3, start: 16, end: 17, text: 'c' },
    ],
  }
  const meta = await buildTrack(lesson, 'clean', { gap: 0.7 })
  assert.deepEqual(Object.keys(meta.items), ['0', '2', '3']) // 噪音句不进声音轨
  const [a, b] = [meta.items[0], meta.items[2]]
  assert.equal(a[0], 0)
  assert.ok(Math.abs(a[1] - 2.42) < 0.02, `第一句长度 ${a[1]}`) // 2 秒 + 前 0.12 + 后 0.3
  assert.ok(Math.abs(b[0] - (a[1] + 0.7)) < 0.002, '句间停 0.7 秒')
  // 三句 2.42 + 3.42 + 1.42 秒，两个 0.7 秒停顿，结尾 0.5 秒 = 9.16 秒（原音频 20 秒）
  assert.ok(Math.abs(meta.duration - 9.16) < 0.03, `总长 ${meta.duration}`)
  assert.ok((await stat(join(dir, 'tracks', 'clean.mp3'))).size > 1000)
  assert.deepEqual(Object.keys(await listTracks(id)), ['clean'])
  await assert.rejects(buildTrack(lesson, 'full'), /没有这种声音/)
})
