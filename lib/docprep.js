// lib/docprep.js — 用 AI 把从文档里取出的原始文字整理成能导入的格式（# 章节、段落、只留正文）
//
// 原始文字按约 1 万字符分段，几段同时整理；每段都告诉模型上一段的结尾和当前章节，接缝处才连得上。
// 整理完逐段核对英文单词数：模型删掉太多（少于 60%）就重来一次，还不行就用原文简单接好断行——宁可难看，不能丢内容。

import { normalize } from './doc.js'

export const CHUNK_CHARS = 10000

const SYSTEM = `你是文字整理员。给你的是从 PDF / Word / 电子书 / 网页里取出的英文原始文字（其中一段），要整理成英语听力软件能导入的纯文本。规则：
1. 只保留正文英文：删掉页眉、页脚、页码、目录、版权声明、联系方式、网址和邮箱、图片说明、脚注编号，以及 ® ™ 这类符号。
2. 修好断行：行尾被拆开的单词接回去；同一段落的多行接成一行；段落之间空一行。
3. 章节：原文的大标题（一章的开头）单独一行写成「# 标题」，小标题写成「## 小标题」。原文没有章节的长文，大约每 800–1500 个英文单词加一个「# 」标题，用几个英文单词概括。
4. 原文的句子一个字都不要改：不要翻译、改写、总结、补充，也不要加任何解释或前后说明。
5. 这一段可能从段落中间开始、在段落中间结束，照原样整理，不要补写缺的部分。
6. 格式必须严格：标题前后各空一行，段落和段落之间空一行。原文里单独成行、很短、没有句号的行（如 "Cautions and Warnings"、"Chapter 3—Free Flow"）就是标题，一定要加「# 」或「## 」。
输出示例：
# The First Chapter

First paragraph. Its second sentence.

## A Section Title

Another paragraph.

只输出整理后的文字。`

const words = t => (String(t).match(/[A-Za-z][A-Za-z'’-]*/g) || []).length

/** 按行切成约 CHUNK_CHARS 的几段，尽量在空行处切 */
export function chunkText(raw, size = CHUNK_CHARS) {
  const lines = normalize(raw).split('\n')
  const chunks = []
  let cur = []
  let len = 0
  for (const line of lines) {
    cur.push(line)
    len += line.length + 1
    const blank = line.trim() === ''
    if (len >= size && (blank || len >= size * 1.3)) { chunks.push(cur.join('\n').trim()); cur = []; len = 0 }
  }
  if (cur.join('').trim()) chunks.push(cur.join('\n').trim())
  return chunks.filter(Boolean)
}

/** 原文简单整理（模型靠不住时的退路）：接断行、段落空一行 */
export function plainTidy(raw) {
  return normalize(raw)
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
}

/** 像标题的行：不长、没有句末标点、多数词首字母大写（"Cautions and Warnings: Please Read"） */
function looksLikeHeading(line, next) {
  if (line.length > 90 || /[.!?,;]$/.test(line) || !/^[A-Z0-9"“‘'(]/.test(line)) return false
  const ws = line.split(/\s+/).filter(Boolean)
  if (ws.length > 12) return false
  // 只看以字母开头的实词（「#4—NVC」「12」这种不算）
  const big = ws.filter(w => w.length > 3 && /^["“‘'(]?[A-Za-z]/.test(w))
  if (big.length && big.filter(w => /^["“‘'(]?[A-Z0-9]/.test(w)).length / big.length < 0.6) return false
  // 下一行以小写开头：这是被断开的句子，不是标题
  return !next || !/^[a-z]/.test(next)
}

/**
 * 把模型的输出（或原文）规整成导入格式，不管它守没守规矩：
 * 认出标题加「## 」，句子中途断开的行接回去，每段之间空一行。已经合格的文字过一遍不变。
 */
export function ensureStructure(text) {
  const lines = String(text).split('\n').map(l => l.trim())
  const blocks = []
  let para = ''
  const flush = () => { if (para) { blocks.push(para); para = '' } }
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]
    if (!line) { flush(); continue }
    if (/^#{1,6}\s/.test(line)) { flush(); blocks.push(line); continue }
    const next = lines.slice(k + 1).find(Boolean) || ''
    if (!para && looksLikeHeading(line, next)) { blocks.push(`## ${line}`); continue }
    para = para ? `${para} ${line}` : line
    // 这一行说完了（句末标点）、下一行另起：就是一段的结尾
    if (/[.!?…"”’)]$/.test(line) && !/^[a-z]/.test(next)) flush()
  }
  flush()
  return blocks.join('\n\n')
}

/** 去掉模型偶尔加上的代码块围栏和开场白 */
function stripWrapper(t) {
  return String(t || '').replace(/^```[a-z]*\n?|```\s*$/gi, '').trim()
}

/**
 * 预估：词数、朗读时长、大约几课、要多久、多少 token
 * 粗算：朗读每分钟 150 词；一课最多 160 句（约 2000 词）；
 * 模型输出 token：整理 ≈ 字符数 / 4，翻译讲解 ≈ 每句 120
 */
export function estimate(text, { needsCleanup = true } = {}) {
  const w = words(text)
  const chars = text.length
  const sentences = Math.max(1, Math.round(w / 16))
  const chunks = needsCleanup ? Math.max(1, Math.ceil(chars / CHUNK_CHARS)) : 0
  const tokens = Math.round((needsCleanup ? chars / 4 : 0) + sentences * 120)
  // 整理：每段约 40 秒、3 段并行；朗读（Edge）约为时长的 1/4；翻译：每 20 句一批约 15 秒、3 批并行
  const seconds = Math.ceil(chunks / 3) * 40 + (w / 150) * 60 / 4 + Math.ceil(sentences / 20 / 3) * 15
  return {
    words: w, chars, sentences,
    audioMinutes: Math.max(1, Math.round(w / 150)),
    lessons: Math.max(1, Math.ceil(sentences / 130)),
    chunks, tokens,
    minutes: Math.max(1, Math.round(seconds / 60)),
  }
}

/**
 * @param {object} llm complete() 接口
 * @param {string} raw 原始文字
 * @param {{title?:string, signal?:AbortSignal, concurrency?:number, chunkChars?:number, onProgress?(done,total):void}} o
 * @returns {Promise<{text:string, warnings:string[]}>}
 */
export async function cleanupText(llm, raw, o = {}) {
  const chunks = chunkText(raw, o.chunkChars || CHUNK_CHARS)
  const out = new Array(chunks.length)
  const warnings = []
  let done = 0
  let next = 0
  const one = async (k) => {
    const chunk = chunks[k]
    const prev = k > 0 ? chunks[k - 1].slice(-300).replace(/\s+/g, ' ') : ''
    const user = [
      o.title ? `材料：${o.title}` : '',
      `这是第 ${k + 1} / ${chunks.length} 段。`,
      prev ? `上一段原文的结尾是：「…${prev}」（只用来接上下文，不要输出）` : '这是开头。',
      '',
      '原始文字：',
      chunk,
    ].filter(x => x !== null).join('\n')
    const want = words(chunk)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (o.signal && o.signal.aborted) throw new Error('已取消')
      try {
        const text = stripWrapper(await llm.complete({ system: SYSTEM, user, maxTokens: 16000, signal: o.signal }))
        const got = words(text)
        if (want < 30 || got >= want * 0.6) { out[k] = ensureStructure(text); return }
      } catch (e) {
        if (o.signal && o.signal.aborted) throw e
        if (attempt === 1) warnings.push(`第 ${k + 1} 段整理失败（${e.message}），用了原文`)
      }
    }
    if (!out[k]) {
      out[k] = ensureStructure(plainTidy(chunk))
      if (!warnings.some(w => w.startsWith(`第 ${k + 1} 段`))) warnings.push(`第 ${k + 1} 段 AI 整理后少了很多内容，改用原文（可能留有页眉页码）`)
    }
  }
  const workers = Array.from({ length: Math.min(o.concurrency || 3, chunks.length) }, async () => {
    while (next < chunks.length) {
      const k = next++
      await one(k)
      done++
      if (o.onProgress) o.onProgress(done, chunks.length)
    }
  })
  await Promise.all(workers)
  // 接缝：下一段开头重复了上一段最后的章节标题就去掉
  const parts = []
  let lastHeading = ''
  for (const t of out) {
    let s = t
    const first = /^#\s+(.+)$/m.exec(s)
    if (first && s.trimStart().startsWith('#') && first[1].trim() === lastHeading) s = s.replace(/^\s*#\s+.+\n?/, '')
    const hs = [...s.matchAll(/^#\s+(.+)$/gm)]
    if (hs.length) lastHeading = hs[hs.length - 1][1].trim()
    parts.push(s.trim())
  }
  return { text: parts.filter(Boolean).join('\n\n'), warnings }
}
