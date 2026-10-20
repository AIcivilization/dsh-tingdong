import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeSegments } from '../lib/asr.js'
import { grade, INTERVALS, isMastered, reviewQueue, stats } from '../lib/srs.js'
import { cleanItem, extractJson, translateSentences } from '../lib/translate.js'

test('srs: 听懂了升格、没听懂打回、半懂停在低格', () => {
  const t = 1_000_000
  let c = grade(undefined, 2, t)
  assert.equal(c.box, 1)
  assert.equal(c.due, t + INTERVALS[1])
  for (let k = 0; k < 3; k++) c = grade(c, 2, t)
  assert.equal(c.box, 4)
  assert.ok(isMastered(c))
  c = grade(c, 0, t)
  assert.equal(c.box, 0)
  assert.equal(c.again, 1)
  assert.equal(c.due, t + INTERVALS[0])
  c = grade({ box: 5, seen: 3, good: 3, again: 0 }, 1, t)
  assert.equal(c.box, 2)
  assert.ok(!isMastered(c))
})

test('srs: 复习队列先到期的，再补新句子', () => {
  const now = 10_000
  const cards = { 1: { box: 1, due: 9000 }, 2: { box: 2, due: 5000 }, 3: { box: 3, due: 20_000 } }
  const q = reviewQueue([0, 1, 2, 3, 4, 5], cards, { now, newLimit: 2 })
  assert.deepEqual(q, [2, 1, 0, 4])
  const s = stats([0, 1, 2, 3, 4, 5], cards, now)
  assert.equal(s.seen, 3)
  assert.equal(s.due, 2)
  assert.equal(s.fresh, 3)
  assert.equal(s.nextDue, 20_000)
})

test('mergeSegments: 太短或没说完的和后一句接上，长句不拼', () => {
  const out = mergeSegments([
    { start: 0, end: 0.5, text: 'First.' },
    { start: 1.2, end: 5, text: 'Your energy conversion box.' },
    { start: 5.5, end: 9, text: 'Then go on' },
    { start: 9.4, end: 12, text: 'to Focus 10.' },
    { start: 30, end: 31, text: 'Next.' },
    { start: 31.5, end: 50, text: 'A very long sentence that would make the chunk too long.' },
    { start: 60, end: 61, text: '   ' },
  ])
  assert.deepEqual(out.map(s => s.text), [
    'First. Your energy conversion box.',
    'Then go on to Focus 10.',
    'Next.',
    'A very long sentence that would make the chunk too long.',
  ])
  assert.equal(out[0].start, 0)
  assert.equal(out[0].end, 5)
})

test('extractJson: 容忍代码块和前后废话', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"items":[{"i":1}]}\n```'), { items: [{ i: 1 }] })
  assert.throws(() => extractJson('没有'))
})

test('cleanItem: 缺字段给空值，生词去掉空的', () => {
  const c = cleanItem({ en: ' Hi. ', zh: '你好', words: [{ w: 'hi', zh: '嗨' }, { w: '' }, null], skip: 'yes' })
  assert.equal(c.en, 'Hi.')
  assert.equal(c.words.length, 1)
  assert.equal(c.words[0].ipa, '')
  assert.equal(c.skip, false)
})

test('translateSentences: 缺的句子缩小批次重试，噪音句标 skip', async () => {
  const calls = []
  const llm = {
    async complete({ user }) {
      const ids = [...user.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]))
      calls.push(ids)
      // 第一次整批时故意漏掉 2 号
      const items = ids.filter(i => !(calls.length === 1 && i === 2)).map(i => (
        i === 0 ? { i, en: 'Yeah.', zh: '', skip: true } : { i, en: `S${i}.`, zh: `句${i}`, words: [], sound: '' }))
      return JSON.stringify({ items })
    },
  }
  const sentences = [0, 1, 2, 3].map(i => ({ i, text: `s${i}`, zh: '' }))
  const res = await translateSentences(llm, sentences, { batchSize: 10, concurrency: 1 })
  assert.equal(res.failed, 0)
  assert.equal(sentences[0].skip, true)
  assert.equal(sentences[2].zh, '句2')
  assert.equal(sentences[3].en, 'S3.')
  assert.deepEqual(calls[0], [0, 1, 2, 3])
  assert.deepEqual(calls[1], [2])
})

test('translateSentences: 模型一直失败时如实报告，不抛错', async () => {
  const llm = { async complete() { throw new Error('boom') } }
  const sentences = [0, 1].map(i => ({ i, text: `s${i}`, zh: '' }))
  const res = await translateSentences(llm, sentences, { concurrency: 1 })
  assert.equal(res.failed, 2)
  assert.deepEqual(res.errors, ['boom'])
  assert.equal(sentences[0].zh, '')
})
