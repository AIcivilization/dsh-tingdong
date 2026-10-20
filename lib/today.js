// lib/today.js — 首页「今天学什么」：所有课里到期的句子串成一个队列，再补几句新句子；
// 连续学习天数、今天学了几句、大约几分钟，都从每课的评分记录（progress.log）里算出来。
//
// 日期按用户所在时区算（浏览器传来 tz = new Date().getTimezoneOffset()）：VPS 常在 UTC，按服务器时间会把早上 8 点前学的算到前一天。

import { getLesson, getProgress, listLessons, studyIds } from './store.js'

const DAY = 86400000

/** 时间戳 → 用户当地的 YYYY-MM-DD */
export function dayKey(ts, tz = 0) {
  return new Date(ts - tz * 60000).toISOString().slice(0, 10)
}

/** 有学习记录的日子 → 连续天数（今天没学但昨天学了也算没断） */
export function streakOf(days, today) {
  const set = new Set(days)
  const prev = d => new Date(Date.parse(d + 'T12:00:00Z') - DAY).toISOString().slice(0, 10)
  let d = set.has(today) ? today : prev(today)
  let n = 0
  while (set.has(d)) { n++; d = prev(d) }
  return n
}

/** 一天里的学习分钟数：相邻两次评分间隔超过 3 分钟算中途休息，只记 3 分钟 */
export function minutesOf(stamps) {
  const t = [...stamps].sort((a, b) => a - b)
  let ms = t.length ? 30000 : 0
  for (let k = 1; k < t.length; k++) ms += Math.min(t[k] - t[k - 1], 180000)
  return Math.round(ms / 60000)
}

/**
 * @param {{tz?:number, newPerDay?:number, now?:number}} o
 */
export async function today(o = {}) {
  const tz = Number.isFinite(o.tz) ? o.tz : 0
  const now = o.now || Date.now()
  const newPerDay = o.newPerDay ?? 10
  const todayKey = dayKey(now, tz)
  const days = new Set()
  const todayStamps = []
  const perDay = new Map()
  const due = []
  const freshByLesson = []
  let newToday = 0

  for (const meta of await listLessons()) {
    if (!meta.sentences) continue
    const l = await getLesson(meta.id)
    const p = await getProgress(meta.id)
    const cards = p.cards || {}
    const firstSeen = new Map()
    let last = 0
    for (const [ts, i] of p.log || []) {
      const k = dayKey(ts, tz)
      days.add(k)
      perDay.set(k, (perDay.get(k) || 0) + 1)
      if (k === todayKey) todayStamps.push(ts)
      if (!firstSeen.has(i)) firstSeen.set(i, ts)
      last = Math.max(last, ts)
    }
    for (const ts of firstSeen.values()) if (dayKey(ts, tz) === todayKey) newToday++
    const ids = studyIds(l)
    const title = l.titleZh || l.title
    for (const i of ids) {
      const c = cards[i]
      if (c && c.due <= now) due.push({ id: l.id, i, due: c.due, title })
    }
    // 新句子按「学到哪了」接着往下：从 pos 开始，没学过的
    const pos = Number.isInteger(p.pos) ? p.pos : 0
    const fresh = ids.filter((i, k) => !cards[i] && k >= pos).concat(ids.filter((i, k) => !cards[i] && k < pos))
    if (fresh.length) freshByLesson.push({ id: l.id, title, last, fresh })
  }

  due.sort((a, b) => a.due - b.due)
  // 新句子：最近在学的那课优先
  freshByLesson.sort((a, b) => b.last - a.last)
  const room = Math.max(0, newPerDay - newToday)
  const fresh = []
  for (const f of freshByLesson) {
    for (const i of f.fresh) { if (fresh.length >= room) break; fresh.push({ id: f.id, i, title: f.title, fresh: true }) }
    if (fresh.length >= room) break
  }

  const week = []
  for (let k = 6; k >= 0; k--) {
    const d = dayKey(now - k * DAY, tz)
    week.push({ day: d, count: perDay.get(d) || 0 })
  }
  return {
    today: todayKey,
    dueCount: due.length,
    newCount: fresh.length,
    queue: [...due.map(({ id, i, title }) => ({ id, i, title })), ...fresh],
    streak: streakOf([...days], todayKey),
    todayCount: todayStamps.length,
    newToday,
    minutes: minutesOf(todayStamps),
    week,
  }
}
