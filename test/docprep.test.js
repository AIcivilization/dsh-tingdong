// 导入文档：取文字（Word / EPUB / 网页 / TXT）、AI 整理（分段、核对、退路）、预估
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { chunkText, cleanupText, estimate, plainTidy } from '../lib/docprep.js'
import { docxToText, epubToText, extractText, htmlToText, readZip } from '../lib/extract.js'

const dir = await mkdtemp(join(tmpdir(), 'tingdong-docprep-'))
after(() => rm(dir, { recursive: true, force: true }))

/** 测试用的最小 zip 写入（deflate），和 Word / EPUB 的结构一样 */
function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(content))
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(content), 22); local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(Buffer.byteLength(content), 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, n, data)
    centrals.push(central, n)
    offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

test('zip：读出每个文件', () => {
  const z = readZip(zip({ 'a.txt': 'hello', 'b/c.xml': '<x/>' }))
  assert.equal(z.get('a.txt')().toString(), 'hello')
  assert.equal(z.get('b/c.xml')().toString(), '<x/>')
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /zip/)
})

test('Word：一个 w:p 一段，标题样式变成 # / ##，实体转回来', () => {
  const xml = `<w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter One</w:t></w:r></w:p>
    <w:p><w:r><w:t>First </w:t></w:r><w:r><w:t xml:space="preserve">paragraph &amp; more.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Part A</w:t></w:r></w:p>
    <w:p></w:p>
  </w:body></w:document>`
  assert.equal(docxToText(zip({ 'word/document.xml': xml })), '# Chapter One\n\nFirst paragraph & more.\n\n## Part A')
})

test('EPUB：按 spine 顺序接各章，h1 / h2 变成 # / ##', () => {
  const epub = zip({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    'OEBPS/content.opf': '<package><manifest><item id="c2" href="ch2.xhtml"/><item id="c1" href="ch1.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
    'OEBPS/ch1.xhtml': '<html><head><title>x</title></head><body><h1>One</h1><p>Alpha text.</p></body></html>',
    'OEBPS/ch2.xhtml': '<html><body><h1>Two</h1><p>Beta&#8217;s text.</p><h2>Sub</h2><p>Gamma.</p></body></html>',
  })
  assert.equal(epubToText(epub), '# One\n\nAlpha text.\n\n# Two\n\nBeta’s text.\n\n## Sub\n\nGamma.')
})

test('网页：去掉脚本样式导航，段落空行', () => {
  assert.equal(htmlToText('<nav>menu</nav><script>x()</script><h1>T</h1><p>A<br>b</p><div>C &mdash; d</div>'), '# T\n\nA\nb\n\nC — d')
})

test('extractText：按扩展名选方法；不支持的给人话错误；TXT 认 UTF-16', async () => {
  const f = join(dir, 'a.txt')
  await writeFile(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hello world.', 'utf16le')]))
  assert.deepEqual(await extractText(f), { type: 'TXT', text: 'Hello world.' })
  await writeFile(join(dir, 'a.xyz'), 'x')
  await assert.rejects(extractText(join(dir, 'a.xyz')), /不支持/)
})

test('分段：按行切，尽量在空行处切，内容不丢', () => {
  const para = 'word '.repeat(300).trim()
  const raw = Array.from({ length: 12 }, () => para).join('\n\n')
  const chunks = chunkText(raw, 4000)
  assert.ok(chunks.length >= 3)
  assert.equal(chunks.join('\n\n').replace(/\s+/g, ' '), raw.replace(/\s+/g, ' '))
})

test('简单整理：段内换行接起来，断词接回去', () => {
  assert.equal(plainTidy('Line one\nline two reso-\nnant.\n\n\nNext para.'), 'Line one line two resonant.\n\nNext para.')
})

test('AI 整理：几段并行、按原顺序拼回；接缝处重复的章节标题去掉', async () => {
  const raw = ['# Book\n\nAlpha one two three.', 'Beta four five six.', 'Gamma seven eight.'].join('\n\n')
  const calls = []
  const llm = {
    async complete({ user }) {
      calls.push(user)
      const body = user.split('原始文字：\n')[1]
      // 模拟模型：第二段又写了一遍 # Book
      return body.startsWith('Beta') ? '# Book\n\n' + body : '```\n' + body + '\n```'
    },
  }
  const r = await cleanupText(llm, raw, { concurrency: 3, title: 'T', chunkChars: 20 })
  assert.equal(calls.length, 3)
  assert.deepEqual(r.warnings, [])
  assert.match(calls[1], /上一段原文的结尾是/)
  assert.equal(r.text, '# Book\n\nAlpha one two three.\n\nBeta four five six.\n\nGamma seven eight.')
})

test('AI 整理：模型删掉太多就重来；还不行用原文，并给提醒', async () => {
  const raw = 'Sentence with plenty of words here to count properly. '.repeat(10).trim()
  let n = 0
  const lazy = { async complete() { n++; return 'Too short.' } }
  const r = await cleanupText(lazy, raw)
  assert.equal(n, 2)
  assert.equal(r.text, plainTidy(raw))
  assert.match(r.warnings[0], /改用原文/)
  const broken = { async complete() { throw new Error('timeout') } }
  const r2 = await cleanupText(broken, raw)
  assert.match(r2.warnings[0], /整理失败（timeout）/)
})

test('预估：词数、朗读分钟、课数、token、处理时间', () => {
  const text = 'word '.repeat(4500)
  const e = estimate(text)
  assert.equal(e.words, 4500)
  assert.equal(e.audioMinutes, 30)
  assert.ok(e.lessons >= 2)
  assert.ok(e.chunks >= 2)
  assert.ok(e.minutes >= 1)
  assert.ok(estimate(text, { needsCleanup: false }).tokens < e.tokens)
})

test('规整：认出标题、接回断开的句子、段落空行；合格的文字不变', async () => {
  const { ensureStructure } = await import('../lib/docprep.js')
  const messy = [
    'The Gateway Affirmation',
    'I am more than my physical body. Because I am more than physical matter,',
    'I deeply desire to Expand.',
    'Adventure #4—NVC I',
    'Nonverbal Communication (NVC) is not body language.',
    'Some discover themselves for the first time, and thus live more',
    'completely.',
  ].join('\n')
  const out = ensureStructure(messy)
  assert.equal(out, [
    '## The Gateway Affirmation',
    'I am more than my physical body. Because I am more than physical matter, I deeply desire to Expand.',
    '## Adventure #4—NVC I',
    'Nonverbal Communication (NVC) is not body language.',
    'Some discover themselves for the first time, and thus live more completely.',
  ].join('\n\n'))
  assert.equal(ensureStructure(out), out)
  const good = '# Book\n\nOne paragraph here.\n\n## Part\n\nAnother one.'
  assert.equal(ensureStructure(good), good)
})
