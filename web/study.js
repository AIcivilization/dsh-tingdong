// web/study.js — 精听（按原文顺序一句一句）和复习（自评 / 选意思 / 听写；单课或今日跨课）

import { isMastered, reviewQueue } from './srs.js'
import {
  $, api, cards, clickableEn, esc, fmt, getPos, isPhone, keys, loadAudio, loop, mediaControls, nav, onSwipe,
  player, playSentence, S, savePos, starred, store, toast, useLesson, usable,
} from './core.js'
import { bindWords, openEditor } from './edit.js'
import { dictationDiff } from './dict.js'

// ———————————————————— 共用的卡片部件 ————————————————————

/** 播放区：大播放键 + 重听 / 变速 / 循环 */
function controls() {
  return `<button class="play" id="play" title="播放（空格）" aria-label="播放">▶</button>
    <div class="controls">
      <button class="btn" id="replay">重听<kbd>空格</kbd></button>
      <button class="btn speed" id="speed">${player.rate}×<kbd>S</kbd></button>
      <button class="btn ${loop.on ? 'on' : ''}" id="loop">单句循环<kbd>L</kbd></button>
    </div>`
}

function bindControls(s) {
  $('#play').onclick = () => playSentence(s)
  $('#replay').onclick = () => playSentence(s)
  $('#speed').onclick = () => { $('#speed').innerHTML = `${player.cycleRate()}×<kbd>S</kbd>` }
  $('#loop').onclick = () => {
    loop.on = !loop.on
    $('#loop').classList.toggle('on', loop.on)
    if (loop.on) playSentence(s)
  }
}

/** 收藏、改句子两个小按钮 */
function tools(s) {
  return `<span class="tools">
    <button class="icon-btn star ${starred(s.i) ? 'on' : ''}" id="star" title="收藏到难句本" aria-label="收藏">${starred(s.i) ? '★' : '☆'}</button>
    <button class="icon-btn" id="edit" title="改这一句（识别错了、切错了）" aria-label="编辑">✎</button>
  </span>`
}

function bindTools(s, redraw) {
  $('#star').onclick = async () => {
    const on = !starred(s.i)
    try {
      const r = await api('star', { id: S.cur.lesson.id, i: s.i, on })
      S.cur.progress.stars = r.stars
      $('#star').classList.toggle('on', on)
      $('#star').textContent = on ? '★' : '☆'
      toast(on ? '已收藏到难句本' : '已取消收藏')
    } catch (e) { toast(e.message) }
  }
  $('#edit').onclick = () => openEditor(s, redraw)
}

function wordList(words) {
  if (!words || !words.length) return ''
  return `<div class="words">${words.map(w => `<div class="word"><span class="w0">${esc(w.w)}</span><span class="ipa">${esc(w.ipa)}</span><span class="grow muted">${esc(w.zh)}</span></div>`).join('')}</div>`
}

/** 英文（可点词）+ 识别原文 + 听音提示 */
function enBlock(s) {
  return `<div class="en-line" id="enLine">${clickableEn(s.en || s.text, s.words)}</div>
    ${s.en && s.en !== s.text ? `<div class="asr">识别原文：${esc(s.text)}</div>` : ''}
    ${s.sound ? `<div class="tip"><b>听音</b> ${esc(s.sound)}</div>` : ''}
    <div class="faint tap-hint">点英文里的任意一个词看意思</div>`
}

function zhBlock(s) {
  return `<div class="zh-line">${s.zh ? esc(s.zh) : '<span class="faint">（还没有翻译）</span>'}</div>${wordList(s.words)}`
}

const grades = (labels = ['没听懂', '半懂', '听懂了']) => `<div class="grades actions">
  <button class="btn g0" data-g="0">${labels[0]}<kbd>1</kbd></button>
  <button class="btn g1" data-g="1">${labels[1]}<kbd>2</kbd></button>
  <button class="btn g2" data-g="2">${labels[2]}<kbd>3</kbd></button>
</div>`

export async function gradeIt(s, g) {
  loop.on = false
  const { card } = await api('grade', { id: S.cur.lesson.id, i: s.i, g })
  cards()[s.i] = card
  return card
}

// ———————————————————— 精听 ————————————————————

export function paneStudy(pane, l) {
  const list = usable(l)
  let idx = Math.min(getPos(), list.length - 1)
  let step = 0
  const draw = (autoplay) => {
    const s = list[idx]
    savePos(idx)
    const c = cards()[s.i]
    pane.innerHTML = `<div class="card study" id="card">
      <div class="pos"><span>第 ${idx + 1} / ${list.length} 句 · ${fmt(s.start)}</span>${tools(s)}<span>${c ? (isMastered(c) ? '已掌握' : `听过 ${c.seen} 次`) : '新句子'}</span></div>
      ${controls()}
      ${step === 0 ? `<div class="hint">先只听，不看字。听懂了什么？再听几遍也行。</div>
        <div class="actions"><button class="btn primary big" id="next">显示英文<kbd>回车</kbd></button></div>` : ''}
      ${step >= 1 ? enBlock(s) : ''}
      ${step === 1 ? `<div class="hint">对照着再听一遍，哪个词没听出来？</div>
        <div class="actions"><button class="btn primary big" id="next">显示中文<kbd>回车</kbd></button></div>` : ''}
      ${step >= 2 ? `${zhBlock(s)}<div class="hint">知道意思了，闭上眼再听一遍：现在能直接听懂吗？</div>${grades()}` : ''}
      <div class="nav">
        <button class="btn ghost" id="prev" ${idx ? '' : 'disabled'}>‹ 上一句</button>
        <span class="faint swipe-hint">左右滑动换句</span>
        <button class="btn ghost" id="skip" ${idx < list.length - 1 ? '' : 'disabled'}>下一句 ›</button>
      </div>
      <div class="dots">${list.map((x, k) => { const cc = cards()[x.i]; return `<i data-k="${k}" class="${cc ? 's' + (cc.lastGrade + 1) : ''} ${k === idx ? 'cur' : ''} ${starred(x.i) ? 'st' : ''}" title="第 ${k + 1} 句"></i>` }).join('')}</div>
    </div>`
    bindControls(s)
    bindTools(s, () => { const nl = S.cur.lesson; list.splice(0, list.length, ...usable(nl)); idx = Math.min(idx, list.length - 1); draw(false) })
    if ($('#enLine')) bindWords($('#enLine'), s)
    const nextBtn = $('#next')
    if (nextBtn) nextBtn.onclick = () => { step++; draw(step === 2) }
    $('#prev').onclick = () => move(-1)
    $('#skip').onclick = () => move(1)
    pane.querySelectorAll('[data-g]').forEach(b => { b.onclick = () => rate(s, Number(b.dataset.g)) })
    pane.querySelectorAll('.dots i').forEach(d => { d.onclick = () => { idx = Number(d.dataset.k); step = 0; draw(true) } })
    onSwipe($('#card'), { left: () => move(1), right: () => move(-1) })
    mediaControls({
      title: s.en || s.text, album: l.titleZh || l.title,
      play: () => playSentence(s), pause: () => player.stop(),
      next: () => move(1), prev: () => move(-1),
    })
    if (autoplay) playSentence(s)
  }
  const rate = async (s, g) => {
    try { await gradeIt(s, g) } catch (e) { return toast(e.message) }
    move(1)
  }
  const move = d => {
    const n = idx + d
    if (n < 0) return
    if (n >= list.length) {
      player.stop()
      keys.handler = null
      pane.innerHTML = `<div class="card empty">这一课精听完了 🎉<br><br><button class="btn primary" id="toReview">去复习</button> <button class="btn" id="again">从头再来</button></div>`
      $('#toReview').onclick = () => nav.go(`#/l/${l.id}/review`)
      $('#again').onclick = () => { idx = 0; step = 0; paneStudy(pane, l) }
      return
    }
    idx = n
    step = 0
    draw(true)
  }
  keys.handler = e => {
    const s = list[idx]
    if (!s) return
    if (e.key === ' ') { e.preventDefault(); playSentence(s) }
    else if (e.key === 'Enter') { e.preventDefault(); if (step < 2) { step++; draw(step === 2) } }
    else if (e.key === 'ArrowLeft') move(-1)
    else if (e.key === 'ArrowRight') move(1)
    else if (['1', '2', '3'].includes(e.key) && step >= 2) rate(s, Number(e.key) - 1)
    else commonKeys(e, s)
  }
  draw(false)
}

function commonKeys(e, s) {
  if (e.key === 's' || e.key === 'S') { const b = $('#speed'); if (b) b.click() }
  else if (e.key === 'l' || e.key === 'L') { const b = $('#loop'); if (b) b.click() }
  else if (s && e.key === 'r') playSentence(s)
}

// ———————————————————— 复习：自评 / 选意思 / 听写 ————————————————————

const MODES = { self: '自评', choice: '选意思', dict: '听写' }

/** 选意思：正确的中文 + 同一课里另外两句的中文（长度相近、不挨着） */
function choicesFor(s, l) {
  const pool = usable(l).filter(x => x.i !== s.i && x.zh && Math.abs(x.i - s.i) > 1 && x.zh !== s.zh)
  const len = (s.zh || '').length
  pool.sort((a, b) => Math.abs(a.zh.length - len) - Math.abs(b.zh.length - len))
  const near = pool.slice(0, 8)
  // 每句固定的「随机」：同一句每次的干扰项一样，免得靠排除法
  const seed = n => ((s.i * 9301 + n * 49297) % 233280) / 233280
  const picks = []
  for (let n = 0; picks.length < 2 && near.length; n++) picks.push(near.splice(Math.floor(seed(n) * near.length), 1)[0])
  const opts = [{ zh: s.zh, right: true }, ...picks.map(p => ({ zh: p.zh, right: false }))]
  return opts.sort((a, b) => (seed(a.zh.length) + a.zh.length % 7) - (seed(b.zh.length) + b.zh.length % 7))
}

/**
 * 复习会话：items 是 [{id, i}]，可以跨课
 * @param {HTMLElement} pane
 * @param {{items:{id:string,i:number,title?:string}[], multi?:boolean, empty?:string, after?:()=>void}} o
 */
export function reviewSession(pane, o) {
  const queue = [...o.items]
  let mode = store.get('reviewMode', 'self')
  let shown = false
  let picked = null // 选意思：选了哪个
  let result = null // 听写：对答案的结果
  let done = 0

  const finish = () => {
    player.stop()
    keys.handler = null
    pane.innerHTML = `<div class="card empty">${done ? `这一轮做完了，共 ${done} 句 👏` : (o.empty || '现在没有要复习的句子')}<br><br>
      <div class="row" style="justify-content:center"><button class="btn primary" id="home">回首页</button></div></div>`
    $('#home').onclick = () => nav.go('#/')
    o.after && o.after()
  }

  const draw = async (autoplay) => {
    if (!queue.length) return finish()
    const item = queue[0]
    await useLesson(item.id)
    const l = S.cur.lesson
    const s = l.sentences.find(x => x.i === item.i)
    if (!s || s.skip) { queue.shift(); return draw(autoplay) }
    loadAudio()
    const c = cards()[s.i]
    const answered = shown || picked !== null || result !== null
    const opts = mode === 'choice' && s.zh ? choicesFor(s, l) : null
    const m = opts && opts.length >= 3 ? 'choice' : (mode === 'choice' ? 'self' : mode)
    pane.innerHTML = `
      <div class="chips">${Object.entries(MODES).map(([k, v]) => `<button class="chip ${k === mode ? 'on' : ''}" data-mode="${k}">${v}</button>`).join('')}</div>
      <div class="card study" id="card">
        <div class="pos"><span>还有 ${queue.length} 句${o.multi ? ` · ${esc(l.titleZh || l.title)}` : ''}</span>${tools(s)}<span>${c ? `听过 ${c.seen} 次` : '新句子'}</span></div>
        ${controls()}
        ${!answered && m === 'self' ? `<div class="hint">只听声音，在心里说出它的意思。</div>
          <div class="actions"><button class="btn primary big" id="show">看答案<kbd>回车</kbd></button></div>` : ''}
        ${!answered && m === 'choice' ? `<div class="hint">只听声音，选出它的意思：</div>
          <div class="choices actions">${opts.map((x, k) => `<button class="btn choice" data-k="${k}">${esc(x.zh)}<kbd>${k + 1}</kbd></button>`).join('')}</div>
          <button class="btn ghost small" id="giveup">听不出来</button>` : ''}
        ${!answered && m === 'dict' ? `<div class="hint">把听到的英文打出来（不用管大小写和标点）：</div>
          <input type="text" id="dict" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="听到什么写什么">
          <div class="row actions" style="margin-top:8px"><button class="btn primary" id="check">对答案<kbd>回车</kbd></button><button class="btn ghost" id="giveup">听不出来</button></div>` : ''}
        ${answered ? `
          ${m === 'choice' && picked !== null ? `<div class="verdict ${opts[picked].right ? 'ok' : 'no'}">${opts[picked].right ? '✓ 选对了' : '✗ 选错了'}</div>` : ''}
          ${m === 'dict' && result ? `<div class="verdict ${result.score >= 0.9 ? 'ok' : result.score >= 0.6 ? 'mid' : 'no'}">听出了 ${Math.round(result.score * 100)}%</div>
            <div class="dict-diff">${result.words.map(w => `<span class="${w.ok ? 'ok' : 'miss'}">${esc(w.w)}</span>`).join(' ')}</div>` : ''}
          ${enBlock(s)}${zhBlock(s)}
          ${m === 'self' ? grades() : `<div class="actions"><button class="btn primary big" id="nextQ">下一句<kbd>回车</kbd></button></div>`}` : ''}
      </div>`
    pane.querySelectorAll('[data-mode]').forEach(b => {
      b.onclick = () => { mode = b.dataset.mode; store.set('reviewMode', mode); shown = false; picked = null; result = null; draw(false) }
    })
    bindControls(s)
    bindTools(s, () => draw(false))
    if ($('#enLine')) bindWords($('#enLine'), s)
    const show = $('#show')
    if (show) show.onclick = () => { shown = true; draw(false) }
    pane.querySelectorAll('[data-g]').forEach(b => { b.onclick = () => rate(s, Number(b.dataset.g)) })
    pane.querySelectorAll('.choice').forEach(b => { b.onclick = () => choose(s, opts, Number(b.dataset.k)) })
    const check = $('#check')
    if (check) check.onclick = () => dictate(s)
    const input = $('#dict')
    if (input) {
      input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); dictate(s) } }
      if (!isPhone()) setTimeout(() => input.focus(), 50)
    }
    const giveup = $('#giveup')
    if (giveup) giveup.onclick = async () => { await send(s, 0); shown = true; draw(false) }
    const nextQ = $('#nextQ')
    if (nextQ) nextQ.onclick = () => advance()
    mediaControls({ title: s.en || s.text, album: l.titleZh || l.title, play: () => playSentence(s), pause: () => player.stop() })
    keys.handler = e => {
      if (e.key === ' ') { e.preventDefault(); playSentence(s) }
      else if (e.key === 'Enter') {
        e.preventDefault()
        if (!answered && m === 'self') { shown = true; draw(false) } else if (answered && m !== 'self') advance()
      } else if (['1', '2', '3'].includes(e.key)) {
        if (answered && m === 'self') rate(s, Number(e.key) - 1)
        else if (!answered && m === 'choice') choose(s, opts, Number(e.key) - 1)
      } else commonKeys(e, s)
    }
    if (autoplay) playSentence(s)
  }

  let pending = null // 选意思 / 听写：已经评过的分，按「下一句」时用来决定要不要这一轮再考
  const send = async (s, g) => {
    try { await gradeIt(s, g) } catch (e) { toast(e.message) }
    pending = g
  }
  const choose = async (s, opts, k) => {
    if (!opts || !opts[k]) return
    picked = k
    await send(s, opts[k].right ? 2 : 0)
    draw(false)
  }
  const dictate = async (s) => {
    const typed = ($('#dict') || {}).value || ''
    if (!typed.trim()) return toast('先打出听到的英文；实在听不出来点「听不出来」')
    result = dictationDiff(s.en || s.text, typed)
    await send(s, result.score >= 0.9 ? 2 : result.score >= 0.6 ? 1 : 0)
    draw(false)
  }
  const rate = async (s, g) => { await send(s, g); advance() }
  const advance = () => {
    const g = pending ?? 2
    const item = queue.shift()
    done++
    // 没听懂 / 半懂的：这一轮里隔几句再来一次
    if (g < 2) queue.splice(Math.min(queue.length, g === 0 ? 3 : 6), 0, item)
    shown = false; picked = null; result = null; pending = null
    draw(true)
  }
  draw(false)
}

/** 单课复习：可选「到期的 / 收藏的 / 难句」 */
export function paneReview(pane, l) {
  const scope = store.get('reviewScope', 'due')
  const ids = usable(l).map(s => s.i)
  const cs = cards()
  const pick = {
    due: () => reviewQueue(ids, cs),
    star: () => ids.filter(i => starred(i)),
    hard: () => ids.filter(i => cs[i] && (cs[i].again > 0 || cs[i].lastGrade < 2)),
  }
  const items = (pick[scope] || pick.due)().map(i => ({ id: l.id, i }))
  const head = document.createElement('div')
  head.className = 'chips'
  head.innerHTML = Object.entries({ due: '到期 + 新句', star: `收藏（${ids.filter(i => starred(i)).length}）`, hard: '难句' })
    .map(([k, v]) => `<button class="chip ${k === scope ? 'on' : ''}" data-scope="${k}">${v}</button>`).join('')
  const body = document.createElement('div')
  pane.innerHTML = ''
  pane.append(head, body)
  head.querySelectorAll('[data-scope]').forEach(b => { b.onclick = () => { store.set('reviewScope', b.dataset.scope); paneReview(pane, l) } })
  reviewSession(body, {
    items,
    empty: scope === 'star' ? '还没有收藏的句子：学习时点卡片右上角的 ☆ 收藏' : scope === 'hard' ? '没有难句：标过「没听懂 / 半懂」的句子会出现在这里' : '现在没有要复习的句子',
  })
}

// ———————————————————— 今日学习（跨课） ————————————————————

export async function paneToday(pane) {
  pane.innerHTML = '<div class="empty">正在准备今天的句子…</div>'
  let t
  try { t = await api(`today?tz=${new Date().getTimezoneOffset()}`) } catch (e) { pane.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
  if (!t.queue.length) {
    pane.innerHTML = `<div class="card empty">今天的已经学完了 🎉<br><span class="faint">今天学了 ${t.todayCount} 句 · 约 ${t.minutes} 分钟 · 连续 ${t.streak} 天</span><br><br><button class="btn" id="home">回首页</button></div>`
    $('#home').onclick = () => nav.go('#/')
    return
  }
  const body = document.createElement('div')
  pane.innerHTML = `<div class="faint" style="margin:0 2px 8px">今天：复习 ${t.dueCount} 句 + 新句子 ${t.newCount} 句</div>`
  pane.append(body)
  reviewSession(body, { items: t.queue, multi: true })
}
