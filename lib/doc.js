// lib/doc.js — 导入英文文档：整理好的纯文本 → 一章一课，每课是一句一句的英文
//
// 约定的格式（让别的 AI 先整理好，界面上有现成的整理指令可以复制）：
//   # 章节标题        一行「# 」开头：新的一章，做成一课
//   ## 小标题         小标题也读出来，算一句
//   段落之间空一行；段落内部的换行会被接起来（硬换行、断词的连字符都能处理）
// 没有任何「# 」时整篇算一章；一章太长（超过 MAX_SENTENCES 句）就按段落拆成几课。

export const MAX_CHARS = 400000
export const MAX_SENTENCES = 160

// 句点后面不算句子结束的缩写
const ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'fig', 'no', 'vol', 'p', 'pp', 'ch', 'u.s', 'u.k', 'a.m', 'p.m', 'inc', 'ltd', 'co', 'approx', 'dept', 'est', 'mt', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'])

/** 文本清理：统一换行、去掉不可见字符、接上断词 */
export function normalize(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[­​﻿]/g, '')
    .replace(/‐|‑/g, '-')
    .replace(/(\w)-\n(\w)/g, '$1$2') // 行尾断词
    .replace(/[ \t]+/g, ' ')
}

/** 一段文字切成句子 */
export function splitSentences(paragraph) {
  const p = paragraph.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim()
  if (!p) return []
  const out = []
  let start = 0
  const re = /([.!?…]+)(["'”’)\]]*)(\s+)(?=["'“‘(\[]?[A-Z0-9])/g
  let m
  while ((m = re.exec(p))) {
    const end = m.index + m[1].length + m[2].length
    const before = p.slice(start, m.index)
    const lastWord = (/([A-Za-z.]+)$/.exec(before) || [])[1] || ''
    // 缩写（Mr. / e.g.）和单个大写字母（A. Monroe）后面的句点不断句
    if (m[1] === '.' && (ABBR.has(lastWord.toLowerCase().replace(/\.$/, '')) || /^[A-Z]$/.test(lastWord))) continue
    out.push(p.slice(start, end).trim())
    start = end + m[3].length
  }
  out.push(p.slice(start).trim())
  return out.filter(Boolean).flatMap(splitLong)
}

/** 太长的句子听起来累：超过 220 个字符的，在分号、冒号、破折号处拆开 */
function splitLong(s) {
  if (s.length <= 220) return [s]
  const parts = s.split(/(?<=[;:])\s+|\s+[—–]\s+|(?<=—)/).map(x => x.trim()).filter(Boolean)
  if (parts.length < 2) return [s]
  // 拆得太碎的再并回去
  const merged = []
  for (const x of parts) {
    const last = merged[merged.length - 1]
    if (last && (last.length < 60 || x.length < 40)) merged[merged.length - 1] = `${last} ${x}`
    else merged.push(x)
  }
  return merged
}

/**
 * @returns {{title:string, chapters:{title:string, sentences:{text:string, heading?:boolean, para:number}[]}[]}}
 */
export function parseDoc(text, { title = '' } = {}) {
  const src = normalize(text)
  if (!src.trim()) throw Object.assign(new Error('没有内容'), { status: 400 })
  if (src.length > MAX_CHARS) throw Object.assign(new Error(`太长了（${src.length} 字符）：一次最多 ${MAX_CHARS} 字符，拆成几份导入`), { status: 400 })
  if (/[一-鿿]/.test(src) && (src.match(/[一-鿿]/g) || []).length > src.length * 0.2) {
    throw Object.assign(new Error('看起来大部分是中文：这里导入英文原文，中文由 AI 翻译'), { status: 400 })
  }
  const chapters = []
  let cur = null
  let para = 0
  const newChapter = t => { cur = { title: t, sentences: [] }; chapters.push(cur) }
  for (const block of src.split(/\n\s*\n/)) {
    const lines = block.split('\n')
    let buf = []
    const flush = () => {
      if (!buf.length) return
      if (!cur) newChapter('')
      para++
      for (const s of splitSentences(buf.join('\n'))) cur.sentences.push({ text: s, para })
      buf = []
    }
    for (const raw of lines) {
      const line = raw.trim()
      const h1 = /^#\s+(.+)$/.exec(line)
      const h2 = /^#{2,6}\s+(.+)$/.exec(line)
      if (h1) { flush(); newChapter(h1[1].trim()); continue }
      if (h2) {
        flush()
        if (!cur) newChapter('')
        para++
        cur.sentences.push({ text: h2[1].trim().replace(/[*_`]/g, ''), heading: true, para })
        continue
      }
      // Markdown 的列表符号、强调符号不读
      buf.push(line.replace(/^[-*+]\s+|^\d+[.)]\s+/, '').replace(/[*_`]+/g, ''))
    }
    flush()
  }
  const docTitle = title.trim() || (chapters[0] && chapters[0].title) || firstWords(chapters)
  // 去掉空章；没标题的章用文档标题；太长的章按段落拆开
  const out = []
  for (const [k, c] of chapters.filter(c => c.sentences.length).entries()) {
    const t = c.title || (chapters.length > 1 ? `${docTitle} · 第 ${k + 1} 部分` : docTitle)
    if (c.sentences.length <= MAX_SENTENCES) { out.push({ title: t, sentences: c.sentences }); continue }
    let part = []
    let n = 1
    for (const [j, s] of c.sentences.entries()) {
      part.push(s)
      const paraEnds = !c.sentences[j + 1] || c.sentences[j + 1].para !== s.para
      if (part.length >= MAX_SENTENCES * 0.8 && paraEnds) { out.push({ title: `${t}（${n++}）`, sentences: part }); part = [] }
    }
    if (part.length) out.push({ title: n > 1 ? `${t}（${n}）` : t, sentences: part })
  }
  if (!out.length) throw Object.assign(new Error('没找到英文句子'), { status: 400 })
  return { title: docTitle, chapters: out }
}

function firstWords(chapters) {
  const s = chapters[0] && chapters[0].sentences[0]
  return s ? s.text.split(/\s+/).slice(0, 6).join(' ') : '英文文档'
}

/** 给别的 AI 的整理指令：用户复制过去，连同 PDF / 网页 / 电子书一起发给它 */
export const PREP_PROMPT = `请把我发给你的英文材料整理成纯文本，用来导入英语听力学习软件。要求：
1. 只保留正文英文，删掉页眉、页脚、页码、目录、脚注编号、图片说明、网址和联系方式。
2. 修好因为换行断开的单词（比如 "resonant-" 换行接 "tuning"），段落内部不要硬换行；每个段落一行，段落之间空一行。
3. 每一章单独起一行「# 章节标题」。原文没有章节的，按内容大约每 800–1500 个英文单词分一章，自己起个简短的英文标题。章里的小标题用「## 小标题」。
4. 不要翻译、不要改写、不要总结，原文一个字都不要改；也不要加任何说明。
5. 直接输出整理好的文本（Markdown 纯文本），我会保存成 .txt 或 .md 文件导入。`
