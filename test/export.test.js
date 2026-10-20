// 导出：字幕 / 歌词 / 录音稿 / 表格的格式和时间；中文音色列表
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'tingdong-export-'))
process.env.DSH_TINGDONG_HOME = home
after(() => rm(home, { recursive: true, force: true }))

const { exportText, lrcTime, srtTime, timeline } = await import('../lib/export.js')
const { ZH_VOICES, zhVoice } = await import('../lib/voices.js')
const { EDGE_ZH_VOICES, edgeVoice } = await import('../lib/edge.js')

const lesson = {
  id: 'ex-111111',
  title: 'Demo', titleZh: '示例', group: 'CD4', duration: 3725.5,
  sentences: [
    { i: 0, start: 103.33, end: 105.83, text: 'move now', en: 'Move now.', zh: '现在开始。' },
    { i: 1, start: 110, end: 111, text: 'yeah', en: 'Yeah.', zh: '', skip: true },
    { i: 2, start: 3661.5, end: 3664.25, text: 'next', en: 'Next, "focus".', zh: '下一步，“专注”。' },
  ],
}

test('时间格式：SRT 时:分:秒,毫秒；LRC 分钟可以超过 59', () => {
  assert.equal(srtTime(3661.5), '01:01:01,500')
  assert.equal(srtTime(0.0004), '00:00:00,000')
  assert.equal(lrcTime(103.33), '[01:43.33]')
  assert.equal(lrcTime(3661.5), '[61:01.50]')
})

test('时间轴：非讲话不算；可用时长到下一句开始，最后一句到总长', async () => {
  const { rows, total } = await timeline(lesson, 'full')
  assert.equal(total, 3725.5)
  assert.deepEqual(rows.map(r => r.i), [0, 2])
  assert.equal(rows[0].next, 3661.5)
  assert.equal(rows[1].next, 3725.5)
  await assert.rejects(timeline(lesson, 'clean'), /原声·去空白/)
})

test('双语 SRT：编号连续，每条两行', async () => {
  const { text, ext } = await exportText(lesson, 'srt-bi')
  assert.equal(ext, 'srt')
  assert.equal(text, '1\n00:01:43,330 --> 00:01:45,830\nMove now.\n现在开始。\n\n2\n01:01:01,500 --> 01:01:04,250\nNext, "focus".\n下一步，“专注”。\n')
})

test('中文 SRT 跳过没翻译的句子', async () => {
  const l = { ...lesson, sentences: lesson.sentences.map(s => (s.i === 0 ? { ...s, zh: '' } : s)) }
  const { text } = await exportText(l, 'srt-zh')
  assert.match(text, /^1\n01:01:01,500/)
})

test('LRC：标题头 + 英文、中文同一时间；长空白前清屏', async () => {
  const { text } = await exportText(lesson, 'lrc')
  const lines = text.trim().split('\n')
  assert.equal(lines[0], '[ti:示例]')
  assert.ok(lines.includes('[01:43.33]Move now.'))
  assert.ok(lines.includes('[01:43.33]现在开始。'))
  assert.ok(lines.includes('[01:46.33]'), '句子结束 0.5 秒后放一行空的')
})

test('录音稿：开始时间、英文时长、可用时长、中英对照', async () => {
  const { text } = await exportText(lesson, 'script')
  assert.match(text, /#1 {2}01:43\.3 – 01:45\.8 {2}英文 2\.5 秒 · 可用 3558\.2 秒/)
  assert.match(text, /EN：Move now\.\n中：现在开始。/)
})

test('CSV：带 BOM，引号转义', async () => {
  const { text } = await exportText(lesson, 'csv')
  assert.ok(text.startsWith('﻿"序号"'))
  assert.match(text, /"Next, ""focus""\."/)
  await assert.rejects(exportText(lesson, 'docx'), /没有这种导出格式/)
})

test('中文音色：Kokoro 55 女 45 男，speaker id 对得上；Edge 有男有女', () => {
  assert.equal(ZH_VOICES.filter(v => v.gender === 'f').length, 55)
  assert.equal(ZH_VOICES.filter(v => v.gender === 'm').length, 45)
  assert.equal(zhVoice('f01').sid, 3)
  assert.equal(zhVoice('m01').sid, 58)
  assert.equal(zhVoice('m45').sid, 102)
  assert.equal(zhVoice('nope').id, 'f01')
  assert.ok(EDGE_ZH_VOICES.some(v => v.gender === 'm') && EDGE_ZH_VOICES.some(v => v.gender === 'f'))
  assert.equal(edgeVoice('zh-CN-YunxiNeural').label, '云希（男 · 阳光）')
})
