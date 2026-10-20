// lib/export.js — 把一课导出成文字：字幕（SRT）、歌词（LRC，Walkman 能滚动显示）、录音稿、表格
//
// 时间可以按原音频（full）或「原声·去空白」（clean）算。录音稿给每句标出开始时间和「可用时长」
// （到下一句英文开始为止），照着自己录中文配音时好掌握节奏。

import { listTracks } from './tracks.js'

export const FORMATS = {
  'srt-bi': { label: '双语字幕 SRT', ext: 'srt' },
  'srt-en': { label: '英文字幕 SRT', ext: 'srt' },
  'srt-zh': { label: '中文字幕 SRT', ext: 'srt' },
  lrc: { label: '双语歌词 LRC（Walkman 等播放器滚动显示）', ext: 'lrc' },
  script: { label: '录音稿 TXT（时间 + 可用时长 + 中英对照）', ext: 'txt' },
  csv: { label: '表格 CSV（Excel 能打开）', ext: 'csv' },
}

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0')
/** 01:02:03,456 */
export function srtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000))
  return `${pad(ms / 3600000)}:${pad(ms / 60000 % 60)}:${pad(ms / 1000 % 60)},${pad(ms % 1000, 3)}`
}
/** [01:02.34]（LRC 的分钟可以超过 59） */
export function lrcTime(t) {
  const cs = Math.max(0, Math.round(t * 100))
  return `[${pad(cs / 6000)}:${pad(cs / 100 % 60)}.${pad(cs % 100)}]`
}
const mmss = t => `${pad(t / 60)}:${pad(t % 60)}.${pad(t * 10 % 10, 1)}`

/**
 * 每句在所选时间轴上的时间
 * @returns {Promise<{rows:{i,start,end,next,en,zh}[], total:number, align:string}>}
 */
export async function timeline(lesson, align = 'full') {
  const talk = lesson.sentences.filter(s => !s.skip).sort((a, b) => a.start - b.start)
  let at = s => [s.start, s.end]
  let total = lesson.duration
  if (align === 'clean') {
    const clean = (await listTracks(lesson.id)).clean
    if (!clean) throw Object.assign(new Error('还没有「原声·去空白」，先生成它，或者选按原音频的时间'), { status: 400 })
    at = s => clean.items[s.i] || null
    total = clean.duration
  }
  const placed = talk.map(s => ({ s, t: at(s) })).filter(x => x.t)
  const rows = placed.map((x, k) => ({
    i: x.s.i, start: x.t[0], end: x.t[1],
    next: placed[k + 1] ? placed[k + 1].t[0] : total,
    en: (x.s.en || x.s.text || '').trim(), zh: (x.s.zh || '').trim(),
  }))
  return { rows, total, align: align === 'clean' ? 'clean' : 'full' }
}

const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`

/** @returns {Promise<{text:string, ext:string, label:string}>} */
export async function exportText(lesson, format, align = 'full') {
  const f = FORMATS[format]
  if (!f) throw Object.assign(new Error('没有这种导出格式'), { status: 400 })
  const { rows, total } = await timeline(lesson, align)
  const title = lesson.titleZh ? `${lesson.titleZh}（${lesson.title}）` : lesson.title
  const alignLabel = align === 'clean' ? '「原声·去空白」' : '原音频'
  let text = ''
  if (format.startsWith('srt')) {
    const pick = r => (format === 'srt-en' ? r.en : format === 'srt-zh' ? r.zh : `${r.en}\n${r.zh}`)
    text = rows.filter(r => pick(r).trim()).map((r, k) => `${k + 1}\n${srtTime(r.start)} --> ${srtTime(r.end)}\n${pick(r)}\n`).join('\n')
  } else if (format === 'lrc') {
    const head = [`[ti:${lesson.titleZh || lesson.title}]`, `[al:${lesson.group || '听懂'}]`, '[by:听懂 dsh-tingdong]']
    // 每句两行同一时间：先英文、后中文；句子结束后放一行空的，把字幕清掉
    const body = rows.flatMap(r => [`${lrcTime(r.start)}${r.en}`, ...(r.zh ? [`${lrcTime(r.start)}${r.zh}`] : []), ...(r.next - r.end > 3 ? [`${lrcTime(r.end + 0.5)}`] : [])])
    text = [...head, ...body].join('\n') + '\n'
  } else if (format === 'script') {
    const lines = [
      `${title}`,
      `录音稿 · 时间按${alignLabel}（总长 ${mmss(total)}）· 共 ${rows.length} 句`,
      '「可用」= 从这句开始到下一句英文开始的时间，中文要在这之内说完。',
      '',
    ]
    for (const [k, r] of rows.entries()) {
      lines.push(`#${k + 1}  ${mmss(r.start)} – ${mmss(r.end)}  英文 ${(r.end - r.start).toFixed(1)} 秒 · 可用 ${(r.next - r.start).toFixed(1)} 秒`)
      lines.push(`EN：${r.en}`)
      lines.push(`中：${r.zh || '（还没有翻译）'}`)
      lines.push('')
    }
    text = lines.join('\n')
  } else if (format === 'csv') {
    const head = ['序号', '开始(秒)', '结束(秒)', '可用到(秒)', '英文', '中文']
    // 带 BOM，Excel 才认得出 UTF-8 中文
    text = '﻿' + [head, ...rows.map((r, k) => [k + 1, r.start.toFixed(2), r.end.toFixed(2), r.next.toFixed(2), r.en, r.zh])]
      .map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
  }
  return { text, ext: f.ext, label: f.label }
}
