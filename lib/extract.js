// lib/extract.js — 从文档里取出文字：PDF、Word（.docx）、EPUB 电子书、网页（.html）、TXT / Markdown
//
// 只取文字，不管排版：页眉页码、断行这些交给后面的 AI 整理（lib/docprep.js）。
// docx / epub 本质是 zip：这里用 Node 自带的 zlib 读，不另加依赖；PDF 用 unpdf（纯 JS）。

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export const DOC_EXT = ['.pdf', '.docx', '.epub', '.html', '.htm', '.txt', '.md', '.markdown']

// ———————— zip ————————

/** 读 zip 的目录，返回 name → 取内容的函数 */
export function readZip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const files = new Map()
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    files.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      const data = buf.subarray(start, start + size)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data)
      throw new Error(`zip 里用了不支持的压缩方式（${method}）`)
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}

// ———————— HTML / XML → 文字 ————————

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' }
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** 网页 / EPUB 章节 → 文字：标题变成「# 」「## 」，段落之间空一行 */
export function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style|head|nav|footer|aside)[\s\S]*?<\/\1>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n\n# ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/gi, (_, t) => `\n\n## ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|section|article|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Word：word/document.xml 里一个 <w:p> 是一段，标题样式变成「# / ## 」 */
export function docxToText(buf) {
  const zip = readZip(buf)
  const doc = zip.get('word/document.xml')
  if (!doc) throw new Error('这个 Word 文件里没有正文')
  const xml = doc().toString('utf8')
  const paras = []
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = m[0]
    const style = (/<w:pStyle w:val="([^"]+)"/.exec(p) || [])[1] || ''
    const text = decodeEntities([...p.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map(t => (t[1] !== undefined ? t[1] : ' ')).join('')).trim()
    if (!text) continue
    const h = /^(Heading|标题)\s*(\d)/i.exec(style) || (/^Title$/i.test(style) ? [0, 0, '1'] : null)
    paras.push(h ? `${h[2] === '1' ? '#' : '##'} ${text}` : text)
  }
  return paras.join('\n\n')
}

/** EPUB：按目录（spine）的顺序把各章 XHTML 接起来 */
export function epubToText(buf) {
  const zip = readZip(buf)
  const container = zip.get('META-INF/container.xml')
  const opfPath = container && (/full-path="([^"]+)"/.exec(container().toString('utf8')) || [])[1]
  if (!opfPath || !zip.get(opfPath)) throw new Error('这个 EPUB 文件不完整')
  const opf = zip.get(opfPath)().toString('utf8')
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const items = new Map([...opf.matchAll(/<item\b[^>]*>/g)].map(m => [(/id="([^"]+)"/.exec(m[0]) || [])[1], (/href="([^"]+)"/.exec(m[0]) || [])[1]]))
  const parts = []
  for (const m of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)) {
    const href = items.get(m[1])
    if (!href) continue
    const name = decodeURIComponent(base + href.split('#')[0])
    const f = zip.get(name)
    if (f) parts.push(htmlToText(f().toString('utf8')))
  }
  return parts.filter(Boolean).join('\n\n')
}

/** TXT：UTF-8 / UTF-16（带 BOM）都认 */
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le')
  return buf.toString('utf8').replace(/^﻿/, '')
}

async function pdfToText(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { totalPages, text } = await extractText(pdf, { mergePages: false })
  return { text: text.join('\n\n'), pages: totalPages, perPage: text.map(t => t.trim().length) }
}

/**
 * @returns {Promise<{type:string, text:string, pages?:number, scanned?:boolean}>}
 */
export async function extractText(file, name = file) {
  const ext = extname(name).toLowerCase()
  if (!DOC_EXT.includes(ext)) throw Object.assign(new Error('不支持这种文件：可以导入 PDF、Word（.docx）、EPUB、网页（.html）、TXT、Markdown'), { status: 400 })
  const buf = await readFile(file)
  if (ext === '.pdf') {
    const r = await pdfToText(buf)
    // 每页平均不到 80 个字：多半是扫描版（整页是图片），读不出文字
    const scanned = r.pages > 0 && r.text.replace(/\s/g, '').length / r.pages < 80
    return { type: 'PDF', text: r.text, pages: r.pages, scanned }
  }
  if (ext === '.docx') return { type: 'Word', text: docxToText(buf) }
  if (ext === '.epub') return { type: 'EPUB', text: epubToText(buf) }
  if (ext === '.html' || ext === '.htm') return { type: '网页', text: htmlToText(decodeText(buf)) }
  return { type: ext === '.txt' ? 'TXT' : 'Markdown', text: decodeText(buf) }
}
