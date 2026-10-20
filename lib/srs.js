// lib/srs.js — 间隔复习：一句话要在不同的日子里「一听就懂」好几次，才算真的会了
//
// 简化的莱特纳盒子：听懂了升一格、隔得更久再考；没听懂打回第 0 格，一分钟后再来一次。
// 第 4 格（≥ 7 天后还能听懂）算「掌握」。

const MIN = 60 * 1000
const DAY = 24 * 60 * MIN

/** 第 n 格之后多久再考 */
export const INTERVALS = [1 * MIN, 10 * MIN, 1 * DAY, 3 * DAY, 7 * DAY, 16 * DAY, 35 * DAY, 90 * DAY]
export const MASTERED_BOX = 4

/** 评分：0 没听懂 / 1 半懂 / 2 听懂了 */
export function grade(card, g, now = Date.now()) {
  const c = { box: 0, seen: 0, good: 0, again: 0, ...(card || {}) }
  c.seen++
  c.last = now
  c.lastGrade = g
  if (g >= 2) {
    c.good++
    c.box = Math.min(c.box + 1, INTERVALS.length - 1)
    c.due = now + INTERVALS[c.box]
  } else if (g === 1) {
    c.box = Math.max(1, Math.min(c.box, 2))
    c.due = now + INTERVALS[1]
  } else {
    c.again++
    c.box = 0
    c.due = now + INTERVALS[0]
  }
  return c
}

export const isMastered = c => Boolean(c && c.box >= MASTERED_BOX)

/**
 * 复习队列：先到期的旧句子（最早到期的在前），再按原文顺序补新句子
 * @param {number[]} ids 可以学的句子编号（原文顺序）
 * @param {Record<string, object>} cards
 */
export function reviewQueue(ids, cards, { now = Date.now(), newLimit = 15, limit = 60 } = {}) {
  const due = []
  const fresh = []
  for (const i of ids) {
    const c = cards[i]
    if (!c) fresh.push(i)
    else if (c.due <= now) due.push(i)
  }
  due.sort((a, b) => cards[a].due - cards[b].due)
  return [...due, ...fresh.slice(0, newLimit)].slice(0, limit)
}

/** 一课的进度统计 */
export function stats(ids, cards, now = Date.now()) {
  let seen = 0, mastered = 0, due = 0, learning = 0
  for (const i of ids) {
    const c = cards[i]
    if (!c) continue
    seen++
    if (isMastered(c)) mastered++
    else learning++
    if (c.due <= now) due++
  }
  // 下一次有句子到期是什么时候（没到期的里面最早的）
  let nextDue = null
  for (const i of ids) {
    const c = cards[i]
    if (c && c.due > now && (nextDue === null || c.due < nextDue)) nextDue = c.due
  }
  return { total: ids.length, seen, fresh: ids.length - seen, learning, mastered, due, nextDue }
}
