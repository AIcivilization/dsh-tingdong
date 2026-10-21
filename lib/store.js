// lib/store.js — 课程和进度的读写（JSON 文件，原子写入）
//
// lessons/<id>/lesson.json   内容：句子、时间、校对后的英文、中文、生词、听音提示、全篇概述
// lessons/<id>/progress.json 进度：每句的复习卡片
// lessons/<id>/audio.mp3     压缩后的音频

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { ID_RE, lessonDir, lessonsDir } from './paths.js'
import { grade as gradeCard, stats } from './srs.js'

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

/** 先写临时文件再改名：写到一半断电也不会把课程弄坏 */
async function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 1))
  await rename(tmp, path)
}

// 同一课的写入排队，免得翻译进度和界面评分同时写把对方覆盖掉
const queues = new Map()
function serial(id, fn) {
  const prev = queues.get(id) || Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(id, next.catch(() => {}))
  return next
}

export function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw Object.assign(new Error('课程编号不对'), { status: 400 })
  return id
}

/** 文件名 → 好看的标题：去扩展名、下划线变空格 */
export function titleFromFile(file) {
  return basename(file, extname(file)).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 课程编号：标题的英文字母部分 + 来源的短哈希（同一个文件再导入一次得到同一个编号） */
export function makeId(file, size) {
  const slug = titleFromFile(file).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'lesson'
  const hash = createHash('sha1').update(`${file}\0${size}`).digest('hex').slice(0, 6)
  return `${slug}-${hash}`.replace(/^-+/, '')
}

export const lessonPath = id => join(lessonDir(checkId(id)), 'lesson.json')
export const progressPath = id => join(lessonDir(checkId(id)), 'progress.json')
export const audioPath = id => join(lessonDir(checkId(id)), 'audio.mp3')

export async function getLesson(id) {
  return readJson(lessonPath(id), null)
}

export async function saveLesson(lesson) {
  checkId(lesson.id)
  await mkdir(lessonDir(lesson.id), { recursive: true })
  lesson.updatedAt = Date.now()
  return serial(lesson.id + ':lesson', () => writeJson(lessonPath(lesson.id), lesson))
}

export async function getProgress(id) {
  return readJson(progressPath(id), { cards: {} })
}

/** 给一句评分，返回新卡片 */
export function gradeSentence(id, i, g) {
  return serial(id + ':progress', async () => {
    const p = await getProgress(id)
    p.cards = p.cards || {}
    p.cards[i] = gradeCard(p.cards[i], g)
    p.updatedAt = Date.now()
    p.log = (p.log || []).concat([[Date.now(), Number(i), g]]).slice(-5000)
    await writeJson(progressPath(id), p)
    return p.cards[i]
  })
}

/** 重置进度：清掉复习卡片和记录、回到第一句；收藏的难句和选的声音保留 */
export async function resetProgress(id) {
  return serial(id + ':progress', async () => {
    const p = await getProgress(id)
    await writeJson(progressPath(id), { cards: {}, stars: p.stars || [], track: p.track, updatedAt: Date.now() })
  })
}

/** 改进度里的普通字段：学到第几句（pos）、选的声音（track）。存在服务器上，换设备接着学 */
export function setProgressFields(id, fields) {
  return serial(id + ':progress', async () => {
    const p = await getProgress(id)
    if (Number.isInteger(fields.pos) && fields.pos >= 0) p.pos = fields.pos
    if (typeof fields.track === 'string' && /^[a-z]{2,12}$/.test(fields.track)) p.track = fields.track
    p.updatedAt = Date.now()
    await writeJson(progressPath(id), p)
    return { pos: p.pos, track: p.track }
  })
}

/** 收藏 / 取消收藏一句（难句本） */
export function setStar(id, i, on) {
  return serial(id + ':progress', async () => {
    const p = await getProgress(id)
    const set = new Set(p.stars || [])
    if (on) set.add(Number(i))
    else set.delete(Number(i))
    p.stars = [...set].sort((a, b) => a - b)
    await writeJson(progressPath(id), p)
    return p.stars
  })
}

// —— 改句子：识别偶尔切错、认错字，让用户自己改 ——
// 改动后记 editedAt：声音轨比它旧的，界面会提示重新生成。

function bad(msg) { return Object.assign(new Error(msg), { status: 400 }) }

async function mutateLesson(id, fn) {
  const l = await getLesson(id)
  if (!l) throw Object.assign(new Error('没有这节课'), { status: 404 })
  const out = await fn(l)
  l.editedAt = Date.now()
  await saveLesson(l)
  return out === undefined ? l : out
}

const words = t => String(t || '').trim().split(/\s+/).filter(Boolean)

/** 改一句的英文 / 中文 */
export function editSentence(id, i, patch) {
  return mutateLesson(id, (l) => {
    const s = l.sentences.find(x => x.i === Number(i))
    if (!s) throw bad('没有这一句')
    if (typeof patch.en === 'string') { const t = patch.en.trim().slice(0, 2000); if (!t) throw bad('英文不能为空'); s.en = t }
    if (typeof patch.zh === 'string') s.zh = patch.zh.trim().slice(0, 2000)
    if (typeof patch.skip === 'boolean') s.skip = patch.skip
    return s
  })
}

/** 和下一句合并 */
export function mergeWithNext(id, i) {
  return mutateLesson(id, (l) => {
    const list = [...l.sentences].sort((a, b) => a.start - b.start)
    const k = list.findIndex(x => x.i === Number(i))
    if (k < 0 || k === list.length - 1) throw bad('这是最后一句，后面没有可以合并的')
    const a = list[k]
    const b = list[k + 1]
    a.end = b.end
    a.text = `${a.text} ${b.text}`.trim()
    a.en = `${a.en || a.text} ${b.en || b.text}`.trim()
    a.zh = `${a.zh || ''}${b.zh || ''}`
    a.words = [...(a.words || []), ...(b.words || [])].slice(0, 8)
    a.sound = [a.sound, b.sound].filter(Boolean).join('；')
    a.skip = Boolean(a.skip && b.skip)
    l.sentences = l.sentences.filter(x => x !== b)
    return a
  })
}

/**
 * 从第 at 个词处拆成两句：时间按字数比例分；两句的中文讲解清空，之后重新讲解
 * @returns 新的两句
 */
export function splitSentence(id, i, at) {
  return mutateLesson(id, (l) => {
    const s = l.sentences.find(x => x.i === Number(i))
    if (!s) throw bad('没有这一句')
    const ws = words(s.en || s.text)
    const n = Number(at)
    if (!Number.isInteger(n) || n < 1 || n >= ws.length) throw bad('拆分位置不对')
    const first = ws.slice(0, n).join(' ')
    const second = ws.slice(n).join(' ')
    const cut = s.start + (s.end - s.start) * (first.length / (first.length + second.length))
    const next = {
      i: Math.max(...l.sentences.map(x => x.i)) + 1,
      start: Math.round(cut * 100) / 100, end: s.end,
      text: second, en: second, zh: '', words: [], sound: '', skip: false,
    }
    s.end = next.start
    s.text = first
    s.en = first
    s.zh = ''
    s.words = []
    s.sound = ''
    l.sentences.splice(l.sentences.indexOf(s) + 1, 0, next)
    return [s, next]
  })
}

/** 能学的句子：识别到了、模型没判成噪音 */
export const studyIds = lesson => (lesson.sentences || []).filter(s => !s.skip).map(s => s.i)

/** 课程列表（不带句子，带进度统计） */
export async function listLessons() {
  let names = []
  try { names = await readdir(lessonsDir()) } catch { return [] }
  const out = []
  for (const id of names) {
    if (!ID_RE.test(id)) continue
    const l = await getLesson(id)
    if (!l) continue
    const p = await getProgress(id)
    out.push(summary(l, p))
  }
  out.sort((a, b) => (a.group || '').localeCompare(b.group || '') || (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title))
  return out
}

export function summary(l, p) {
  const ids = studyIds(l)
  const translated = (l.sentences || []).filter(s => s.zh || s.skip).length
  return {
    id: l.id,
    kind: l.kind || 'audio',
    voiceLabel: l.voiceLabel || '',
    title: l.title,
    titleZh: l.titleZh || '',
    group: l.group || '',
    order: l.order ?? 0,
    status: l.status,
    error: l.error || '',
    note: l.note || '',
    duration: l.duration || 0,
    sentences: (l.sentences || []).length,
    translated,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
    hasAudio: existsSync(join(lessonDir(l.id), 'audio.mp3')),
    stats: stats(ids, (p && p.cards) || {}),
  }
}

export async function deleteLesson(id) {
  await rm(lessonDir(checkId(id)), { recursive: true, force: true })
}
