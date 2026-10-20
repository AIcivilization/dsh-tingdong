// lib/lookup.js — 点英文句子里任意一个词查意思；改过 / 拆开的句子重新讲解
//
// 查词结果存进 lesson.lookups（同一个词第二次点不再问模型）。

import { getLesson, saveLesson } from './store.js'
import { extractJson, translateSentences } from './translate.js'

const SYSTEM = `你是英语老师，学生母语是汉语。给你一句英文和其中的一个词（或短语），说明它在这句话里的意思。
只输出一个 JSON 对象：{"w":"词的原形或短语","ipa":"美式音标","pos":"词性（中文，如 动词）","zh":"在这句里的意思（简短）","note":"一句中文补充：常见搭配、和这句的关系、发音要点，没有就空字符串"}`

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '')

/** 规范化：小写、去掉首尾标点 */
export const normWord = w => String(w || '').toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, '').slice(0, 60)

export async function lookupWord(llm, id, i, word) {
  const key = normWord(word)
  if (!key) throw Object.assign(new Error('没有要查的词'), { status: 400 })
  const l = await getLesson(id)
  if (!l) throw Object.assign(new Error('没有这节课'), { status: 404 })
  const cached = l.lookups && l.lookups[key]
  if (cached) return { ...cached, cached: true }
  // 这句里本来就讲过的生词：直接用
  const s = l.sentences.find(x => x.i === Number(i))
  const known = s && (s.words || []).find(w => normWord(w.w) === key)
  if (known) return { w: known.w, ipa: known.ipa, pos: '', zh: known.zh, note: '' }
  if (!llm) throw Object.assign(new Error('没有可用的大模型，查不了这个词'), { status: 400 })
  const text = await llm.complete({
    system: SYSTEM,
    user: `句子：${s ? (s.en || s.text) : ''}\n词：${word}`,
    maxTokens: 4000,
  })
  const j = extractJson(text)
  const out = { w: str(j.w, 80) || key, ipa: str(j.ipa, 120), pos: str(j.pos, 20), zh: str(j.zh, 200), note: str(j.note, 400) }
  const fresh = await getLesson(id)
  fresh.lookups = { ...(fresh.lookups || {}), [key]: out }
  await saveLesson(fresh)
  return out
}

/** 重新讲解几句（清掉旧的中文、生词、听音提示再翻译） */
export async function explainSentences(llm, id, ids) {
  if (!llm) throw Object.assign(new Error('没有可用的大模型'), { status: 400 })
  const l = await getLesson(id)
  if (!l) throw Object.assign(new Error('没有这节课'), { status: 404 })
  const set = new Set(ids.map(Number))
  const targets = l.sentences.filter(s => set.has(s.i))
  if (!targets.length) throw Object.assign(new Error('没有这些句子'), { status: 400 })
  // 只翻译这几句：别的未翻译句子先藏起来
  const others = l.sentences.filter(s => !set.has(s.i) && !s.zh && !s.skip)
  for (const s of others) s.zh = '\u0000'
  for (const s of targets) { s.zh = ''; s.words = []; s.sound = ''; s.skip = false; s.en = s.en || s.text; s.text = s.en }
  // 英文以用户改过的为准，模型只负责讲解
  const userEn = new Map(targets.map(s => [s.i, s.en]))
  try {
    const res = await translateSentences(llm, l.sentences, { hint: [l.group, l.title].filter(Boolean).join(' · '), concurrency: 1 })
    if (res.failed) throw new Error(res.errors[0] || '模型没有给出讲解')
  } finally {
    for (const s of others) s.zh = ''
  }
  const fresh = await getLesson(id)
  for (const t of targets) {
    const s = fresh.sentences.find(x => x.i === t.i)
    if (s) Object.assign(s, { en: userEn.get(t.i), zh: t.zh, words: t.words, sound: t.sound, skip: false })
  }
  await saveLesson(fresh)
  return targets
}
