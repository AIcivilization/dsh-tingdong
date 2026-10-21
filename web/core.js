// web/core.js — 面板的公共部分：工具函数、接口、播放器、全局状态、声音轨、快捷键、锁屏控制

export const $ = sel => document.querySelector(sel)
export const app = $('#app')
export const audio = $('#player')

// ———————————————————— 工具 ————————————————————

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const fmt = s => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0') }
export const fmtDur = s => { const m = Math.round((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟` }
export const when = t => {
  if (!t) return ''
  const d = t - Date.now()
  if (d <= 0) return '现在'
  if (d < 3600e3) return `${Math.ceil(d / 60e3)} 分钟后`
  if (d < 86400e3) return `${Math.round(d / 3600e3)} 小时后`
  return `${Math.round(d / 86400e3)} 天后`
}
export const isPhone = () => window.matchMedia('(max-width: 640px), (pointer: coarse)').matches

export const store = {
  get(k, d) { try { const v = localStorage.getItem('tingdong:' + k); return v === null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('tingdong:' + k, JSON.stringify(v)) } catch { /* 隐私模式等：只是不记住 */ } },
}

export async function api(path, body) {
  const init = body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-tingdong': '1' },
    body: JSON.stringify(body),
  }
  const r = await fetch(path, init)
  let j = {}
  try { j = await r.json() } catch { /* 非 JSON */ }
  if (!r.ok) throw new Error(j.error || `请求失败（${r.status}）`)
  return j
}

let toastTimer
export function toast(text) {
  let el = $('.toast')
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el) }
  el.textContent = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), 2600)
}

// 页面之间互相跳转：由 panel.js 填上，避免模块互相引用
export const nav = { go: () => {}, render: () => {} }

// ———————————————————— 全局状态 ————————————————————

export const S = {
  status: null,
  lessons: [],
  jobs: [],
  voices: null,
  cur: null, // 当前课 { lesson, progress, tracks, trackDefs }
  cache: new Map(), // 今日学习要跨课：课程 id → 同样结构
}

export async function loadLesson(id, { keepCurrent = false } = {}) {
  const [j, voices] = await Promise.all([api(`lesson?id=${encodeURIComponent(id)}`), S.voices ? S.voices : api('voices').catch(() => null)])
  S.voices = voices
  const data = { lesson: j.lesson, progress: j.progress || { cards: {} }, tracks: j.tracks || {}, trackDefs: j.trackDefs || {} }
  data.progress.cards = data.progress.cards || {}
  S.cache.set(id, data)
  if (!keepCurrent) S.cur = data
  return data
}

/** 切到某一课（今日学习里在课和课之间来回切） */
export async function useLesson(id) {
  if (S.cur && S.cur.lesson.id === id) return S.cur
  S.cur = S.cache.get(id) || await loadLesson(id)
  return S.cur
}

export const usable = l => (l.sentences || []).filter(s => !s.skip).sort((a, b) => a.start - b.start)
export const cards = () => S.cur.progress.cards
export const starred = i => (S.cur.progress.stars || []).includes(i)

// ———————————————————— 播放 ————————————————————

const SPEEDS = [1, 0.85, 0.7]
export const player = {
  rate: store.get('rate', 1),
  stopAt: null,
  onEnd: null,
  onTime: null,
  timer: null,
  loaded: '',

  load(id, track = 'full', ver = '') {
    const src = `audio?id=${encodeURIComponent(id)}&track=${track}${ver ? `&v=${ver}` : ''}`
    if (this.loaded !== src) { this.stop(); audio.src = src; this.loaded = src }
  },
  /** 放一段：从 start 前一点点放到 end 后一点点 */
  range(start, end, onEnd) {
    this.stop(false)
    audio.playbackRate = this.rate
    audio.currentTime = Math.max(0, start - 0.12)
    this.stopAt = end + 0.3
    this.onEnd = onEnd || null
    const p = audio.play()
    if (p && p.catch) p.catch(() => toast('点一下播放按钮开始'))
    this.tick()
  },
  /** 连续播放：每 30 毫秒回调当前时间，由调用方决定跳不跳 */
  stream(from, onTime) {
    this.stop(false)
    audio.playbackRate = this.rate
    if (from !== null) audio.currentTime = Math.max(0, from)
    this.stopAt = null
    this.onTime = onTime
    audio.play().catch(() => toast('点一下播放按钮开始'))
    this.tick()
  },
  tick() {
    clearInterval(this.timer)
    this.timer = setInterval(() => {
      if (this.onTime) this.onTime(audio.currentTime)
      if (this.stopAt !== null && audio.currentTime >= this.stopAt) {
        const cb = this.onEnd
        this.stop(false)
        if (cb) cb()
      }
    }, 30)
  },
  stop(clearCb = true) {
    clearInterval(this.timer)
    this.timer = null
    this.stopAt = null
    this.onTime = null
    if (clearCb) this.onEnd = null
    if (!audio.paused) audio.pause()
  },
  get playing() { return !audio.paused },
  cycleRate() {
    const k = SPEEDS.indexOf(this.rate)
    this.rate = SPEEDS[(k + 1) % SPEEDS.length]
    audio.playbackRate = this.rate
    store.set('rate', this.rate)
    return this.rate
  },
}
audio.addEventListener('play', () => document.querySelectorAll('.play').forEach(b => b.classList.add('playing')))
audio.addEventListener('pause', () => document.querySelectorAll('.play').forEach(b => b.classList.remove('playing')))
audio.addEventListener('error', () => { if (audio.src && audio.error) toast('音频加载失败') })

// ———————————————————— 声音轨 ————————————————————
// 同一课有几条声音：原声（完整）、原声·去空白、原声·压背景、系统朗读、Kokoro 朗读。
// 句子在每条里的时间不同，播放一律经 tm(s) 取当前声音里的时间。
// 选的声音存在服务器上的进度里（换设备也一样），本机再记一份兜底。

export const TRACK_ORDER = ['clean', 'cleannr', 'kokoro', 'say', 'full']

export function curTrack(c = S.cur) {
  if (!c) return 'full'
  const want = c.progress.track || store.get(`track:${c.lesson.id}`, '')
  if (want === 'full' || (want && c.tracks[want])) return want
  return c.tracks.clean ? 'clean' : 'full'
}

export function tm(s, c = S.cur) {
  const t = curTrack(c)
  if (t === 'full') return { start: s.start, end: s.end }
  const it = c.tracks[t] && c.tracks[t].items[s.i]
  return it ? { start: it[0], end: it[1] } : null
}

export function loadAudio() {
  const t = curTrack()
  const meta = S.cur.tracks[t]
  player.load(S.cur.lesson.id, t, meta ? meta.createdAt : '')
}

export function useTrack(t) {
  S.cur.progress.track = t
  store.set(`track:${S.cur.lesson.id}`, t)
  api('state', { id: S.cur.lesson.id, track: t }).catch(() => {})
  player.stop()
  loadAudio()
}

export const isDoc = (c = S.cur) => Boolean(c && c.lesson.kind === 'doc')
/** 声音的名字；文档课的「原声」其实是导入时的朗读 */
export const trackLabel = t => (t === 'full' && isDoc() ? `朗读（${S.cur.lesson.voiceLabel || 'AI'}）` : (S.cur.trackDefs[t] && S.cur.trackDefs[t].label) || t)

/** 学到第几句：存服务器（防抖），换设备接着学 */
let posTimer
export function savePos(idx) {
  const c = S.cur
  if (!c) return
  c.progress.pos = idx
  store.set(`pos:${c.lesson.id}`, idx)
  clearTimeout(posTimer)
  posTimer = setTimeout(() => api('state', { id: c.lesson.id, pos: idx }).catch(() => {}), 800)
}
export const getPos = (c = S.cur) => (Number.isInteger(c.progress.pos) ? c.progress.pos : store.get(`pos:${c.lesson.id}`, 0))

// ———————————————————— 一句的播放（含单句循环） ————————————————————

export const loop = { on: false, timer: null }
export function playSentence(s, onEnd) {
  clearTimeout(loop.timer)
  const t = tm(s)
  if (!t) return toast('这句在当前声音里没有：在「概览 → 声音」里重新生成一下')
  player.range(t.start, t.end, () => {
    if (loop.on) loop.timer = setTimeout(() => playSentence(s, onEnd), 800)
    else if (onEnd) onEnd()
  })
}

// ———————————————————— 快捷键、滑动、锁屏控制 ————————————————————

export const keys = { handler: null }
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const t = e.target
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  if (!keys.handler) return
  if (t && t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) e.preventDefault()
  keys.handler(e)
})

/** 在卡片上左右滑：左滑下一句，右滑上一句 */
export function onSwipe(el, { left, right }) {
  let x0 = null
  let y0 = null
  el.addEventListener('touchstart', e => { const p = e.touches[0]; x0 = p.clientX; y0 = p.clientY }, { passive: true })
  el.addEventListener('touchend', e => {
    if (x0 === null) return
    const p = e.changedTouches[0]
    const dx = p.clientX - x0
    const dy = p.clientY - y0
    x0 = null
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    if (dx < 0 && left) left()
    if (dx > 0 && right) right()
  }, { passive: true })
}

/** 锁屏界面 / 耳机线控：播放暂停、上一句、下一句 */
export function mediaControls(o) {
  if (!('mediaSession' in navigator)) return
  const ms = navigator.mediaSession
  try {
    if (o.title) ms.metadata = new window.MediaMetadata({ title: o.title, artist: o.artist || '听懂', album: o.album || '' })
    const set = (action, fn) => { try { ms.setActionHandler(action, fn || null) } catch { /* 有的浏览器不支持某个动作 */ } }
    set('play', o.play)
    set('pause', o.pause)
    set('previoustrack', o.prev)
    set('nexttrack', o.next)
    set('seekbackward', o.back || null)
    set('seekforward', null)
  } catch { /* 忽略 */ }
}
export function clearMediaControls() { mediaControls({}) }

// ———————————————————— 英文句子：标生词、可点的词 ————————————————————

/** 把英文拆成可点的词（data-k 是第几个词），讲过的生词标黄 */
export function clickableEn(text, words) {
  const src = String(text || '')
  const marks = []
  for (const w of (words || []).map(x => x.w).filter(Boolean)) {
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    let m
    while ((m = re.exec(src))) marks.push([m.index, m.index + m[0].length])
  }
  const out = []
  let last = 0
  let k = 0
  for (const m of src.matchAll(/[A-Za-z0-9'’-]+/g)) {
    const at = m.index
    const word = m[0]
    const hl = marks.some(([a, b]) => at < b && at + word.length > a)
    out.push(esc(src.slice(last, at)), `<span class="w${hl ? ' hl' : ''}" data-k="${k++}">${esc(word)}</span>`)
    last = at + word.length
  }
  out.push(esc(src.slice(last)))
  return out.join('')
}
