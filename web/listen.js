// web/listen.js — 连续听、磨耳朵、词汇

import {
  $, api, audio, clearMediaControls, curTrack, esc, fmt, getPos, isDoc, keys, mediaControls, player, playSentence, S, store, tm,
  toast, trackLabel, usable,
} from './core.js'

// ———————————————————— 连续听 ————————————————————
// 一句接一句不停。用「去空白」或朗读的声音时没有等待；用完整原声时可以跳过长空白（音乐）。

export function paneText(pane, l) {
  const full = curTrack() === 'full'
  const list = l.sentences.filter(s => (full ? true : tm(s))).sort((a, b) => a.start - b.start)
  const opt = { en: store.get('showEn', true), zh: store.get('showZh', true), skip: store.get('skipGaps', true) }
  pane.innerHTML = `
    <div class="sticky-ctl"><div class="row">
      <button class="btn primary" id="playAll">▶ 连续播放</button>
      <button class="btn ${opt.en ? 'on' : ''}" id="tEn">英文</button>
      <button class="btn ${opt.zh ? 'on' : ''}" id="tZh">中文</button>
      ${full && !isDoc() ? `<button class="btn ${opt.skip ? 'on' : ''}" id="tSkip" title="跳过句子之间较长的空白和音乐">跳过空白</button>` : ''}
      <button class="btn speed" id="speed">${player.rate}×</button>
      <a class="btn ghost" href="audio?id=${encodeURIComponent(l.id)}&track=${curTrack()}&download=1" download title="存成 MP3，放到手机或播放器上听">下载 MP3</a>
    </div>${full && !isDoc() ? '<div class="faint" style="margin-top:4px">现在是完整原声（含音乐和空白）。上面「声音」选「原声·去空白」或朗读，就能不停顿地连续听。</div>' : ''}</div>
    <div class="card" id="sents" style="padding:6px">${list.map(s => {
      const t = tm(s)
      return `<div class="sent ${opt.en ? '' : 'hide-e'} ${opt.zh ? '' : 'hide-z'}" data-i="${s.i}">
        <div class="tm">${t ? fmt(t.start) : ''}</div>
        <div class="grow">${s.skip ? `<div class="blank">（非讲话：${esc(s.text)}）</div>` : `<div class="e">${esc(s.en || s.text)}</div><div class="z">${esc(s.zh)}</div>`}</div>
      </div>`
    }).join('')}</div>`
  const rows = new Map([...pane.querySelectorAll('.sent')].map(el => [Number(el.dataset.i), el]))
  const talk = list.filter(s => !s.skip).map(s => ({ i: s.i, ...tm(s) })).sort((a, b) => a.start - b.start)
  let cur = -1
  const mark = i => {
    if (i === cur) return
    if (rows.get(cur)) rows.get(cur).classList.remove('cur')
    cur = i
    const el = rows.get(i)
    if (el) { el.classList.add('cur'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }) }
  }
  const stopAll = () => { player.stop(); $('#playAll').textContent = '▶ 连续播放' }
  const startAll = (from) => {
    $('#playAll').textContent = '❚❚ 暂停'
    player.stream(from, t => {
      const k = talk.findIndex(x => t < x.end + 0.3)
      if (k < 0 || audio.ended) { stopAll(); return }
      const x = talk[k]
      if (t >= x.start - 0.2) mark(x.i)
      // 完整原声里跳过空白：离下一句还有 1.5 秒以上就直接跳过去
      if (full && opt.skip && t < x.start - 1.5) audio.currentTime = x.start - 0.4
    })
  }
  const jump = d => {
    const k = Math.max(0, Math.min(talk.length - 1, talk.findIndex(x => x.i === cur) + d))
    if (!talk[k]) return
    mark(talk[k].i)
    if (player.playing) audio.currentTime = Math.max(0, talk[k].start - 0.1)
  }
  $('#playAll').onclick = () => {
    if (player.playing) return stopAll()
    const x = talk.find(y => y.i === cur) || talk[0]
    if (x) startAll(Math.max(0, x.start - (cur >= 0 ? 0.1 : 0.3)))
  }
  const toggle = (key, btn, cls) => {
    opt[key] = !opt[key]
    store.set({ en: 'showEn', zh: 'showZh', skip: 'skipGaps' }[key], opt[key])
    $(btn).classList.toggle('on', opt[key])
    if (cls) rows.forEach(el => el.classList.toggle(cls, !opt[key]))
  }
  $('#tEn').onclick = () => toggle('en', '#tEn', 'hide-e')
  $('#tZh').onclick = () => toggle('zh', '#tZh', 'hide-z')
  if ($('#tSkip')) $('#tSkip').onclick = () => toggle('skip', '#tSkip')
  $('#speed').onclick = () => { $('#speed').textContent = `${player.cycleRate()}×` }
  rows.forEach((el, i) => {
    el.onclick = () => {
      const s = list.find(x => x.i === i)
      const t = tm(s)
      if (!t) return
      mark(i)
      if (player.playing && player.onTime) { audio.currentTime = Math.max(0, t.start - 0.1); return }
      player.range(t.start, t.end)
    }
  })
  mediaControls({
    title: `${l.titleZh || l.title} · 连续听`, album: trackLabel(curTrack()),
    play: () => { if (!player.playing) $('#playAll').click() }, pause: () => stopAll(),
    next: () => jump(1), prev: () => jump(-1),
  })
  keys.handler = e => {
    if (e.key === ' ') { e.preventDefault(); $('#playAll').click() }
    else if (e.key === 's' || e.key === 'S') $('#speed').click()
    else if (e.key === 'ArrowRight') jump(1)
    else if (e.key === 'ArrowLeft') jump(-1)
  }
}

// ———————————————————— 磨耳朵 ————————————————————
// 服务器把选中的句子做成一段音频：每句放几遍，停几秒让你想意思。锁屏也能一直放，耳机线控能切句。

const SUBS = { step: '逐步显示', always: '一直显示', none: '不显示' }
const SCOPES = { all: '全部', from: '从学到的地方', hard: '难句', star: '收藏', due: '待复习' }

export function paneDrill(pane, l) {
  const o = {
    scope: store.get('drillScope', 'all'),
    repeat: store.get('drillRepeat', 2),
    pause: store.get('drillPause', 3),
    subs: store.get('drillSubs', 'step'),
  }
  const stars = (S.cur.progress.stars || []).length
  pane.innerHTML = `<div class="card">
    <h3>磨耳朵</h3>
    <div class="faint">不用动手：每句放几遍，停一下让你在心里说出意思，再接下一句。适合走路、通勤、做家务时戴耳机听；锁屏也能一直放，耳机线控可以切句。</div>
    <div class="form">
      <label>范围</label><div class="chips">${Object.entries(SCOPES).map(([k, v]) => `<button class="chip ${k === o.scope ? 'on' : ''}" data-scope="${k}">${v}${k === 'star' ? `（${stars}）` : ''}</button>`).join('')}</div>
      <label>每句放</label><div class="chips">${[1, 2, 3, 4].map(n => `<button class="chip ${n === o.repeat ? 'on' : ''}" data-rep="${n}">${n} 遍</button>`).join('')}</div>
      <label>想的时间</label><div class="chips">${[0, 2, 3, 5, 8].map(n => `<button class="chip ${n === o.pause ? 'on' : ''}" data-pause="${n}">${n ? n + ' 秒' : '不停'}</button>`).join('')}</div>
      <label>字幕</label><div class="chips">${Object.entries(SUBS).map(([k, v]) => `<button class="chip ${k === o.subs ? 'on' : ''}" data-subs="${k}">${v}</button>`).join('')}</div>
    </div>
    <div class="faint" style="margin:6px 0 10px">声音：${esc(trackLabel(curTrack()))}（在上面的「声音」里换）。逐步显示＝第 1 遍不看字，第 2 遍显示英文，想的时候显示中文。</div>
    <button class="btn primary big" id="go">生成并开始</button>
  </div>
  <div id="drill"></div>`
  const pick = (attr, key, cast = String) => pane.querySelectorAll(`[data-${attr}]`).forEach(b => {
    b.onclick = () => {
      o[key] = cast(b.dataset[attr])
      store.set({ scope: 'drillScope', repeat: 'drillRepeat', pause: 'drillPause', subs: 'drillSubs' }[key], o[key])
      pane.querySelectorAll(`[data-${attr}]`).forEach(x => x.classList.toggle('on', x === b))
    }
  })
  pick('scope', 'scope')
  pick('rep', 'repeat', Number)
  pick('pause', 'pause', Number)
  pick('subs', 'subs')
  $('#go').onclick = async () => {
    const btn = $('#go')
    btn.disabled = true
    btn.textContent = '正在生成…'
    try {
      const scope = o.scope === 'from' ? 'all' : o.scope
      const from = o.scope === 'from' ? getPos() : 0
      const d = await api('drill', { id: l.id, track: curTrack(), repeat: o.repeat, pause: o.pause, scope, from })
      runDrill($('#drill'), l, d, o)
      $('#drill').scrollIntoView({ block: 'start', behavior: 'smooth' })
    } catch (e) { toast(e.message) }
    btn.disabled = false
    btn.textContent = '重新生成并开始'
  }
  keys.handler = null
}

function runDrill(box, l, d, o) {
  const byI = new Map(l.sentences.map(s => [s.i, s]))
  player.load(l.id, d.name)
  let k = -1
  let phase = ''
  box.innerHTML = `<div class="card study drill">
    <div class="pos"><span id="dPos">共 ${d.items.length} 句 · ${fmt(d.duration)}</span><span id="dPhase"></span></div>
    <button class="play" id="dPlay" aria-label="播放">▶</button>
    <div class="controls">
      <button class="btn" id="dPrev">‹ 上一句</button>
      <button class="btn" id="dNext">下一句 ›</button>
      <a class="btn ghost" href="audio?id=${encodeURIComponent(l.id)}&track=${d.name}&download=1" download>下载这段音频</a>
    </div>
    <div id="dText" class="drill-text"><div class="hint">点 ▶ 开始。可以锁屏，用耳机线控暂停、切句。</div></div>
    <div class="bar" style="margin-top:12px"><i id="dBar" style="width:0"></i></div>
  </div>`
  const show = () => {
    const it = d.items[k]
    if (!it) return
    const s = byI.get(it.i)
    $('#dPos').textContent = `第 ${k + 1} / ${d.items.length} 句`
    $('#dPhase').textContent = phase === 'think' ? '想一想' : `第 ${phase + 1} 遍`
    const showEn = o.subs === 'always' || (o.subs === 'step' && (phase === 'think' || phase >= 1))
    const showZh = o.subs === 'always' || (o.subs === 'step' && phase === 'think')
    $('#dText').innerHTML = `${showEn ? `<div class="en-line">${esc(s.en || s.text)}</div>` : '<div class="en-line faint">· · ·</div>'}
      ${showZh ? `<div class="zh-line">${esc(s.zh || '')}</div>` : ''}`
  }
  const onTime = t => {
    let n = k
    if (n < 0 || !d.items[n] || t < d.items[n].reps[0][0] - 0.05 || (d.items[n + 1] && t >= d.items[n + 1].reps[0][0] - 0.05)) {
      n = d.items.findIndex((it, j) => t >= it.reps[0][0] - 0.05 && (!d.items[j + 1] || t < d.items[j + 1].reps[0][0] - 0.05))
    }
    if (n < 0) n = 0
    const it = d.items[n]
    let p = 'think'
    for (let r = it.reps.length - 1; r >= 0; r--) if (t >= it.reps[r][0] - 0.05 && t < it.think[0]) { p = r; break }
    if (n !== k || p !== phase) { k = n; phase = p; show() }
    $('#dBar').style.width = `${Math.min(100, t / d.duration * 100)}%`
    if (audio.ended) { player.stop(); $('#dText').innerHTML = '<div class="hint">这一段听完了 👏</div>' }
  }
  const play = () => {
    if (player.playing) { player.stop(); return }
    player.stream(audio.currentTime || 0, onTime)
  }
  const seek = dk => {
    const n = Math.max(0, Math.min(d.items.length - 1, (k < 0 ? 0 : k) + dk))
    audio.currentTime = d.items[n].reps[0][0]
    onTime(audio.currentTime)
    if (!player.playing) player.stream(null, onTime)
  }
  $('#dPlay').onclick = play
  $('#dPrev').onclick = () => seek(-1)
  $('#dNext').onclick = () => seek(1)
  mediaControls({
    title: `${l.titleZh || l.title} · 磨耳朵`, album: '听懂',
    play: () => { if (!player.playing) player.stream(null, onTime) }, pause: () => player.stop(),
    next: () => seek(1), prev: () => seek(-1), back: () => seek(0),
  })
  keys.handler = e => {
    if (e.key === ' ') { e.preventDefault(); play() }
    else if (e.key === 'ArrowRight') seek(1)
    else if (e.key === 'ArrowLeft') seek(-1)
  }
  play()
}

// ———————————————————— 词汇：全篇术语 + 每句的生词 + 查过的词 ————————————————————

export function paneWords(pane, l) {
  const seen = new Map()
  for (const s of usable(l)) for (const w of s.words || []) {
    const k = w.w.toLowerCase()
    if (!seen.has(k)) seen.set(k, { ...w, i: s.i, n: 0 })
    seen.get(k).n++
  }
  const terms = (l.terms || []).map(t => {
    const k = t.w.toLowerCase()
    const s = usable(l).find(x => (x.en || x.text).toLowerCase().includes(k))
    return { ...t, i: s ? s.i : null }
  })
  const termKeys = new Set(terms.map(t => t.w.toLowerCase()))
  const words = [...seen.values()].filter(w => !termKeys.has(w.w.toLowerCase()))
  const looked = Object.values(l.lookups || {})
  pane.innerHTML = `
    ${terms.length ? `<div class="card"><h3>关键术语（${terms.length}）</h3>${terms.map(t => `
      <div class="term" ${t.i !== null ? `data-i="${t.i}" style="cursor:pointer"` : ''}>
        <div class="row"><span class="w0">${esc(t.w)}</span><span class="faint">${esc(t.ipa)}</span>${t.i !== null ? '<span class="link">▶ 听原句</span>' : ''}</div>
        <div>${esc(t.zh)}</div>${t.explain ? `<div class="faint">${esc(t.explain)}</div>` : ''}
      </div>`).join('')}</div>` : ''}
    ${looked.length ? `<div class="card"><h3>我查过的词（${looked.length}）</h3>${looked.map(w => `
      <div class="word"><span class="w0">${esc(w.w)}</span><span class="ipa">${esc(w.ipa)}</span><span class="grow muted">${esc(w.zh)}</span></div>`).join('')}</div>` : ''}
    <div class="card"><h3>生词和短语（${words.length}）</h3>${words.length ? words.map(w => `
      <div class="word" data-i="${w.i}" style="cursor:pointer"><span class="w0">${esc(w.w)}</span><span class="ipa">${esc(w.ipa)}</span><span class="grow muted">${esc(w.zh)}</span>${w.n > 1 ? `<span class="faint">×${w.n}</span>` : ''}<span class="link">▶</span></div>`).join('') : '<div class="faint">还没有</div>'}</div>`
  pane.querySelectorAll('[data-i]').forEach(el => {
    el.onclick = () => { const s = l.sentences.find(x => x.i === Number(el.dataset.i)); if (s) playSentence(s) }
  })
  keys.handler = null
  clearMediaControls()
}
