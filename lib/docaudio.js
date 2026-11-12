// lib/docaudio.js — 文档转音频：把一份文档分出来的几课朗读，按顺序接成一个 MP3 下载
//
// 各课的朗读都是同一个编码器出的（24 kHz 单声道 64 kbps MP3），参数一样，直接拼接、不重新编码：
// 几个小时的书也是一眨眼。章与章之间插一段 1.5 秒静音。拼好的缓存在 docs/<docId>/audio.mp3，
// 哪一课的朗读比它新就重拼。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot, findFfmpeg, FFMPEG_HINT } from './paths.js'
import { audioPath, getLesson, listLessons } from './store.js'

const GAP = 1.5

function run(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err = (err + d).slice(-2000) })
    p.on('error', reject)
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`拼接音频失败：${err.trim().split('\n').slice(-2).join(' ')}`))))
  })
}

/** 这份文档的几课（按原文顺序），以及它们的朗读文件 */
export async function docLessons(docId) {
  const metas = (await listLessons()).filter(l => l.docId === docId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  return metas
}

/**
 * 整篇文档的音频
 * @returns {Promise<{file:string, title:string, voiceLabel:string, lessons:number}>}
 */
export async function wholeDocAudio(docId, o = {}) {
  if (!/^[a-f0-9]{12}$/.test(String(docId))) throw Object.assign(new Error('文档编号不对'), { status: 400 })
  const ffmpeg = findFfmpeg(o.ffmpeg)
  if (!ffmpeg) throw Object.assign(new Error(FFMPEG_HINT), { status: 500 })
  const lessons = await docLessons(docId)
  if (!lessons.length) throw Object.assign(new Error('没有这份文档的课'), { status: 404 })
  const missing = lessons.filter(l => !existsSync(audioPath(l.id)))
  if (missing.length) throw Object.assign(new Error(`还有 ${missing.length} 课没朗读完，等做好了再下载`), { status: 409 })
  const first = await getLesson(lessons[0].id)
  const dir = join(dataRoot(), 'docs', docId)
  await mkdir(dir, { recursive: true })
  let title = first.group || first.title
  try { title = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')).title || title } catch { /* 没有存档信息就用组名 */ }
  const out = join(dir, 'audio.mp3')
  const info = { file: out, title, voiceLabel: first.voiceLabel || '', lessons: lessons.length }
  if (lessons.length === 1) return { ...info, file: audioPath(lessons[0].id) }

  // 缓存还新就直接用
  if (existsSync(out)) {
    const built = (await stat(out)).mtimeMs
    const newest = Math.max(...await Promise.all(lessons.map(async l => (await stat(audioPath(l.id))).mtimeMs)))
    if (built >= newest) return info
  }
  const gap = join(dir, 'gap.mp3')
  if (!existsSync(gap)) await run(ffmpeg, ['-f', 'lavfi', '-i', `anullsrc=r=24000:cl=mono`, '-t', String(GAP), '-c:a', 'libmp3lame', '-b:a', '64k', gap])
  const q = p => `file '${p.replace(/'/g, "'\\''")}'`
  const list = lessons.flatMap((l, k) => (k ? [q(gap), q(audioPath(l.id))] : [q(audioPath(l.id))])).join('\n')
  const listFile = join(dir, 'concat.txt')
  await writeFile(listFile, list + '\n')
  const part = join(dir, 'audio.part.mp3')
  try {
    await run(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-metadata', `title=${title}`, '-metadata', 'artist=听懂 dsh-tingdong', part])
    await rename(part, out)
  } finally {
    await rm(part, { force: true })
    await rm(listFile, { force: true })
  }
  return info
}
