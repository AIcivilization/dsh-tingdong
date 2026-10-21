// 导入文档：切句、分章、长章拆分、格式检查
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_SENTENCES, normalize, parseDoc, PREP_PROMPT, splitSentences } from '../lib/doc.js'

test('切句：缩写、单个大写字母、引号、数字都不误切', () => {
  assert.deepEqual(splitSentences('Voiced by Robert A. Monroe. Mr. Smith left at 10 a.m. on the U.S. coast. He said, "Focus 12 is next." Then he left.'), [
    'Voiced by Robert A. Monroe.',
    'Mr. Smith left at 10 a.m. on the U.S. coast.',
    'He said, "Focus 12 is next."',
    'Then he left.',
  ])
  assert.deepEqual(splitSentences('What can you expect? As much as you put in! See e.g. Fig. 3.'), ['What can you expect?', 'As much as you put in!', 'See e.g. Fig. 3.'])
})

test('段落里的硬换行接起来，行尾断词接回去', () => {
  assert.equal(normalize('reso-\nnant tuning'), 'resonant tuning')
  assert.deepEqual(splitSentences('This is one\nsentence across lines. And\nanother.'), ['This is one sentence across lines.', 'And another.'])
})

test('太长的句子在分号、冒号、破折号处拆开', () => {
  const long = 'There is only one basis—that you seriously consider the Gateway Affirmation at the least a possibility: that you are more than your physical body, that you can and do exist in energy systems that are not limited to time-space, that you can and do communicate with intelligence beyond your physical consciousness—call it what you will.'
  const parts = splitSentences(long)
  assert.ok(parts.length >= 2)
  // 拆开再拼回去，一个词都不丢（破折号两边的空格不计）
  const squash = t => t.replace(/\s*—\s*/g, '—').replace(/\s+/g, ' ').trim()
  assert.equal(squash(parts.join(' ')), squash(long))
  assert.ok(parts.every(p => p.length <= 260))
})

test('分章：# 一章一课；## 小标题读出来算一句；列表和强调符号去掉', () => {
  const d = parseDoc('# One\n\nFirst para. Second sentence.\n\n## Sub head\n\n- item **bold** text.\n\n# Two\n\nLast one.')
  assert.equal(d.title, 'One')
  assert.deepEqual(d.chapters.map(c => c.title), ['One', 'Two'])
  const one = d.chapters[0].sentences
  assert.deepEqual(one.map(s => s.text), ['First para.', 'Second sentence.', 'Sub head', 'item bold text.'])
  assert.equal(one[2].heading, true)
  assert.ok(one[0].para === one[1].para && one[3].para !== one[1].para)
})

test('没有 # 时整篇一课，标题用给的或前几个词', () => {
  assert.deepEqual(parseDoc('Hello there. Bye now.', { title: '我的文章' }).chapters.map(c => c.title), ['我的文章'])
  assert.equal(parseDoc('Hello there my friend how are you today.').title, 'Hello there my friend how are')
})

test('太长的一章按段落拆成几课', () => {
  const para = Array.from({ length: 10 }, (_, k) => `Sentence number ${k}.`).join(' ')
  const text = '# Long\n\n' + Array.from({ length: 40 }, () => para).join('\n\n')
  const d = parseDoc(text)
  assert.ok(d.chapters.length >= 3)
  assert.ok(d.chapters.every(c => c.sentences.length <= MAX_SENTENCES))
  assert.equal(d.chapters[0].title, 'Long（1）')
  // 不在段落中间切开
  for (const c of d.chapters) assert.equal(c.sentences.length % 10, 0)
})

test('空的、太长的、几乎全是中文的都给出人话错误', () => {
  assert.throws(() => parseDoc('   \n '), /没有内容/)
  assert.throws(() => parseDoc('x'.repeat(400001)), /太长/)
  assert.throws(() => parseDoc('这是一篇中文文章，里面几乎没有英文。'), /中文/)
})

test('整理指令写明格式要求', () => {
  assert.match(PREP_PROMPT, /# 章节标题/)
  assert.match(PREP_PROMPT, /不要翻译/)
})
