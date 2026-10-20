// web/panel.js — 听懂的学习面板：路由、首页（今日学习、导入、课程、发送到 VPS）、课程页框架和概览
//
// 页面：#/ 首页 · #/today 今日学习（跨课） · #/l/<id>/<tab> 一节课（概览 / 精听 / 复习 / 连续听 / 磨耳朵 / 词汇）
// 学法：先盲听 → 看英文找出没听出来的 → 看中文和生词 → 再听一遍 → 自评；评分进间隔复习，
// 「没听懂」一分钟后再考，「听懂了」隔得越来越久，7 天后还能听懂算掌握。

import { stats } from './srs.js'
import {
  $, api, app, clearMediaControls, curTrack, esc, fmt, fmtDur, getPos, keys, loadAudio, loadLesson, loop, nav, player,
  playSentence, S, TRACK_ORDER, trackLabel, store, tm, toast, usable, useTrack, when,
} from './core.js'
import { paneDrill, paneText, paneWords } from './listen.js'
import { paneReview, paneStudy, paneToday } from './study.js'

// ———————————————————— 路由 ————————————————————

function route() {
  const h = location.hash.replace(/^#/, '')
  if (h === '/today') return { view: 'today' }
  const m = /^\/l\/([a-z0-9-]+)(?:\/(\w+))?/.exec(h)
  return m ? { view: 'lesson', id: m[1], tab: m[2] || 'overview' } : { view: 'library' }
}

const go = hash => { if (location.hash !== hash) location.hash = hash; else render() }
nav.go = go
nav.render = () => render()
window.addEventListener('hashchange', () => render())

$('#back').addEventListener('click', () => go('#/'))
if (window.top !== window) $('#popout').hidden = false

// ———————————————————— 任务 ————————————————————

// 轮询：有任务在跑时每 1.5 秒一次；任务结束就刷新课程
let lastJobsKey = ''
async function pollJobs() {
  try {
    const { jobs } = await api('jobs')
    const before = new Map(S.jobs.map(j => [j.id, j.state]))
    S.jobs = jobs
    for (const j of jobs) {
      if (j.kind === 'send' && before.get(j.id) === 'running' && j.state === 'done') toast('已经发到 VPS，手机上刷新就能看到')
    }
    const key = jobs.map(j => j.id + j.state).join()
    const active = jobs.some(j => j.state === 'running' || j.state === 'queued')
    if (key !== lastJobsKey) {
      lastJobsKey = key
      await refreshLessons()
      const r = route()
      if (r.view === 'lesson' && S.cur && jobs.some(j => j.lessonId === r.id)) { S.voices = null; await loadLesson(r.id) }
      render(true)
    } else if (active) renderJobs()
  } catch { /* 下次再试 */ }
  setTimeout(pollJobs, S.jobs.some(j => j.state === 'running' || j.state === 'queued') ? 1500 : 5000)
}

async function refreshLessons() {
  try { S.lessons = (await api('lessons')).lessons } catch (e) { toast(e.message) }
}

function renderJobs() {
  const box = $('#jobs')
  if (!box) {
    // 在课程页：只更新顶部的进度条
    const bar = $('#lessonJob')
    if (bar && S.cur) {
      const j = S.jobs.find(x => x.lessonId === S.cur.lesson.id && (x.state === 'running' || x.state === 'queued'))
      bar.innerHTML = j ? jobLine(j) : ''
    }
    return
  }
  const recent = S.jobs.filter(j => j.state === 'running' || j.state === 'queued' || (j.finishedAt && Date.now() - j.finishedAt < 60e3 && j.state !== 'done'))
  box.innerHTML = recent.length ? `<div style="margin-top:12px">${recent.map(jobLine).join('')}</div>` : ''
  box.querySelectorAll('[data-cancel]').forEach(b => {
    b.onclick = async () => { try { await api('cancel', { job: b.dataset.cancel }); pollJobsNow() } catch (e) { toast(e.message) } }
  })
}

function jobLine(j) {
  const pct = j.total ? Math.round(j.done / j.total * 100) : (j.state === 'running' ? 5 : 0)
  const state = { queued: '排队中', running: j.stage, error: '出错', cancelled: '已取消', done: '完成' }[j.state]
  return `<div style="margin:8px 0">
    <div class="row small"><span class="grow ellipsis">${esc(j.title)}</span>
      <span class="muted">${esc(state)}${j.total ? ` ${j.done}/${j.total} ${esc(j.message || '')}` : ''}</span>
      ${j.state === 'running' || j.state === 'queued' ? `<button class="btn ghost small" data-cancel="${esc(j.id)}" style="padding:0 8px">取消</button>` : ''}</div>
    ${j.state === 'running' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
    ${j.error ? `<div class="small" style="color:var(--bad)">${esc(j.error)}</div>` : ''}
  </div>`
}

let pollNowTimer
function pollJobsNow() { clearTimeout(pollNowTimer); pollNowTimer = setTimeout(async () => { try { S.jobs = (await api('jobs')).jobs; lastJobsKey = ''; renderJobs() } catch { /* 忽略 */ } }, 200) }

// ———————————————————— 渲染入口 ————————————————————

let rendered = ''
async function render(soft = false) {
  const r = route()
  $('#back').hidden = r.view === 'library'
  if (!soft) { keys.handler = null; loop.on = false; clearMediaControls() }
  if (r.view === 'library') {
    if (!soft) player.stop()
    $('#brand').textContent = '听懂 · 英文听力'
    rendered = 'library'
    renderLibrary()
    // 从课程页回来：进度变了，后台重新拉一次课程列表
    if (!soft) refreshLessons().then(() => { if (route().view === 'library') renderLibrary() })
    return
  }
  if (r.view === 'today') {
    if (soft && rendered === 'today') return
    player.stop()
    rendered = 'today'
    $('#brand').textContent = '今日学习'
    app.innerHTML = '<section id="pane"></section>'
    return paneToday($('#pane'))
  }
  if (!S.cur || S.cur.lesson.id !== r.id) {
    app.innerHTML = '<div class="empty">正在打开…</div>'
    try { await loadLesson(r.id) } catch (e) { app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
  }
  const l = S.cur.lesson
  $('#brand').textContent = l.titleZh || l.title
  const key = `lesson:${l.id}:${r.tab}`
  // 轮询触发的软刷新：正在学习的页面别打断
  if (soft && rendered === key && ['study', 'review', 'text', 'drill'].includes(r.tab)) return
  if (rendered !== key) player.stop()
  rendered = key
  if (l.sentences && l.sentences.length) loadAudio()
  renderLesson(r.tab)
}

// ———————————————————— 首页 ————————————————————

function renderLibrary() {
  const st = S.status || {}
  const canImport = !S.status || st.ffmpeg
  const warn = []
  if (S.status && !st.models && canImport) warn.push('第一次导入会先下载语音识别模型（约 240 MB），之后都在本机识别。')
  if (S.status && !st.llm && canImport) warn.push('没找到可用的大模型：只能识别英文，翻译讲解要等配置好模型后点「补全翻译」。')

  const groups = new Map()
  for (const l of S.lessons) {
    const g = l.group || ''
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(l)
  }

  app.innerHTML = `
    <div id="todayCard">${todayCard(S.today)}</div>
    ${warn.length ? `<div class="card small">${warn.map(w => `<div>⚠ ${w}</div>`).join('')}</div>` : ''}
    ${S.lessons.length ? '' : `<div class="empty">还没有课。导入一个英文 MP3：本机识别出每一句英文，AI 翻译讲解，然后一句一句练到一听就懂。</div>`}
    ${[...groups].map(([g, ls]) => `
      ${g ? `<div class="group-title">${esc(g)}</div>` : (groups.size > 1 ? '<div class="group-title">其他</div>' : '')}
      ${ls.map(lessonCard).join('')}`).join('')}
    ${canImport ? `<div class="card">
      <h3>导入英文音频</h3>
      <div class="drop" id="drop">
        <div class="row">
          <input type="text" class="grow" id="path" placeholder="粘贴 MP3 文件或文件夹的路径" style="flex:1 1 200px">
          <button class="btn primary" id="importBtn">导入</button>
        </div>
        <div class="faint" style="margin-top:8px">也可以把音频拖到这里，或 <a href="#" class="link" id="pick">选择文件</a>。文件夹会把里面的每个音频各做成一课。</div>
        <input type="file" id="file" accept="audio/*,.mp3,.m4a,.m4b,.wav,.flac,.ogg,.opus,.aac" multiple hidden>
      </div>
      <div id="jobs"></div>
    </div>` : `<div class="card small muted">这里只用来学习：在电脑上导入、做好课，再用电脑上的「发送到 VPS」发过来。<div id="jobs"></div></div>`}
    <div id="vpsCard"></div>
  `
  renderJobs()
  loadToday()
  renderVps()
  app.querySelectorAll('.lesson').forEach(el => { el.onclick = () => go(`#/l/${el.dataset.id}`) })
  if (!canImport) return

  const input = $('#path')
  input.value = store.get('lastPath', '')
  const doImport = async () => {
    const p = input.value.trim()
    if (!p) return toast('先填路径')
    store.set('lastPath', p)
    $('#importBtn').disabled = true
    try {
      const { items } = await api('import', { path: p })
      const fresh = items.filter(x => !x.existed).length
      toast(fresh ? `已加入 ${fresh} 个音频，正在处理` : '这些都导入过了')
      pollJobsNow()
    } catch (e) { toast(e.message) }
    $('#importBtn').disabled = false
  }
  $('#importBtn').onclick = doImport
  input.onkeydown = e => { if (e.key === 'Enter') doImport() }
  $('#pick').onclick = e => { e.preventDefault(); $('#file').click() }
  $('#file').onchange = e => uploadFiles([...e.target.files])
  const drop = $('#drop')
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over') }
  drop.ondragleave = () => drop.classList.remove('over')
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); uploadFiles([...e.dataTransfer.files]) }
}

// —— 今日学习卡片 ——
async function loadToday() {
  try {
    S.today = await api(`today?tz=${new Date().getTimezoneOffset()}`)
    const box = $('#todayCard')
    if (box) { box.innerHTML = todayCard(S.today); bindToday() }
  } catch { /* 首页照常显示 */ }
}

function todayCard(t) {
  if (!t) return '<div class="card today"><div class="faint">正在看今天要学什么…</div></div>'
  const n = t.queue.length
  const max = Math.max(1, ...t.week.map(d => d.count))
  const wd = ['日', '一', '二', '三', '四', '五', '六']
  return `<div class="card today">
    <div class="row">
      <div class="grow">
        <div class="big-num">${n ? `今天要学 <b>${n}</b> 句` : (t.todayCount ? '今天的学完了 🎉' : '今天没有要学的')}</div>
        <div class="faint">${n ? `复习 ${t.dueCount} 句 · 新句子 ${t.newCount} 句` : '可以去「连续听」或「磨耳朵」再听一遍'}</div>
      </div>
      <div class="streak" title="连续学习天数"><b>${t.streak}</b><span>连续天数</span></div>
    </div>
    <div class="week">${t.week.map(d => `<div class="day ${d.day === t.today ? 'now' : ''}"><i style="height:${Math.round(d.count / max * 100)}%" title="${d.count} 句"></i><span>${wd[new Date(d.day + 'T12:00:00').getDay()]}</span></div>`).join('')}</div>
    <div class="row" style="margin-top:10px">
      <button class="btn primary big grow" id="goToday" ${n ? '' : 'disabled'}>${n ? '开始今天的学习' : '已完成'}</button>
      <span class="faint">今天 ${t.todayCount} 句 · 约 ${t.minutes} 分钟</span>
    </div>
  </div>`
}
function bindToday() { const b = $('#goToday'); if (b) b.onclick = () => go('#/today') }

function lessonCard(l) {
  const s = l.stats
  const pct = s.total ? Math.round(s.mastered / s.total * 100) : 0
  const seenPct = s.total ? Math.round(s.seen / s.total * 100) : 0
  const badge = {
    queued: '<span class="badge warn">排队中</span>',
    transcribing: '<span class="badge warn">识别中</span>',
    translating: '<span class="badge warn">翻译中</span>',
    paused: '<span class="badge warn">已暂停</span>',
    error: '<span class="badge err">出错</span>',
  }[l.status] || (s.due ? `<span class="badge">待复习 ${s.due}</span>` : (s.total && s.mastered === s.total ? '<span class="badge ok">已掌握</span>' : ''))
  return `<div class="card lesson" data-id="${esc(l.id)}">
    <div class="row"><div class="grow"><div class="t">${esc(l.titleZh || l.title)}</div>${l.titleZh ? `<div class="en">${esc(l.title)}</div>` : ''}</div>${badge}</div>
    <div class="faint" style="margin:6px 0">${fmtDur(l.duration)} · ${l.sentences} 句${l.translated < l.sentences ? ` · 已翻译 ${l.translated}` : ''} · 学过 ${s.seen} · 掌握 ${s.mastered}/${s.total}${s.nextDue && !s.due ? ` · 下次复习 ${when(s.nextDue)}` : ''}</div>
    <div class="bar two"><i class="seen" style="width:${seenPct}%"></i><i style="width:${pct}%"></i></div>
    ${l.error ? `<div class="small" style="color:var(--bad);margin-top:6px">${esc(l.error)}</div>` : ''}
  </div>`
}

function uploadFiles(files) {
  files = files.filter(f => /\.(mp3|m4a|m4b|aac|wav|flac|ogg|opus|wma|mp4|webm)$/i.test(f.name))
  if (!files.length) return toast('没有音频文件')
  const box = $('#jobs')
  const next = () => {
    const f = files.shift()
    if (!f) { pollJobsNow(); return }
    const line = document.createElement('div')
    line.innerHTML = `<div class="row small" style="margin-top:10px"><span class="grow">上传 ${esc(f.name)}</span><span class="muted" data-p>0%</span></div><div class="bar"><i style="width:0"></i></div>`
    box.prepend(line)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `upload?name=${encodeURIComponent(f.name)}`)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.setRequestHeader('x-tingdong', '1')
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return
      const p = Math.round(e.loaded / e.total * 100)
      line.querySelector('[data-p]').textContent = p + '%'
      line.querySelector('i').style.width = p + '%'
    }
    xhr.onload = () => {
      line.remove()
      try { const j = JSON.parse(xhr.responseText); if (xhr.status >= 400) toast(j.error || '上传失败') } catch { toast('上传失败') }
      next()
    }
    xhr.onerror = () => { line.remove(); toast('上传失败'); next() }
    xhr.send(f)
  }
  next()
}

// —— 发送到 VPS（只在做课的电脑上出现：这台机器的 SSH 配置里有主机） ——
let vpsFound = null // 刚查到的 VPS 上的 DSH
async function renderVps() {
  const box = $('#vpsCard')
  if (!box) return
  try { S.vps = await api('vps') } catch { return }
  const v = S.vps
  if (!v.enabled || (!v.config && !v.hosts.length)) { box.innerHTML = ''; return }
  const c = v.config
  const editing = !c || box.dataset.edit === '1'
  box.innerHTML = `<div class="card" id="vps">
    <h3>手机学习（VPS）</h3>
    ${!editing ? `
      <div class="small">发到：<b>${esc(c.domain || c.host)}</b> <span class="faint">（SSH ${esc(c.host)} · 用户 ${esc(c.user)}）</span></div>
      ${v.url ? `<div class="row" style="margin-top:8px"><span class="faint">手机打开：</span><a class="link ellipsis grow" href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.url)}</a><button class="btn ghost" id="copyUrl">复制</button></div>` : ''}
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="sendAll">全部发送到 VPS</button>
        <button class="btn ghost" id="vpsEdit">改设置</button>
      </div>
      <div class="faint" style="margin-top:6px">只发课程内容和声音，不会覆盖 VPS 上的学习进度。每课页面的「管理」里也能单独发送。VPS 上的 DSH 要装好「听懂」插件。</div>` : `
      <div class="faint">在电脑上做好课，发到 VPS 上的 DSH，手机打开就能学。这台电脑要能用 SSH 钥匙登录 VPS（dsh-vps-manager 添加机器时会自动配好）。</div>
      <div class="row" style="margin-top:8px">
        <span class="faint">SSH 主机</span>
        <select id="vpsHost">${v.hosts.map(h => `<option ${c && c.host === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>
        <button class="btn" id="vpsDetect">查找 VPS 上的 DSH</button>
      </div>
      <div id="vpsFound">${vpsFound ? foundList(vpsFound) : ''}</div>
      ${c ? '<button class="btn ghost" id="vpsCancel" style="margin-top:8px">取消</button>' : ''}`}
  </div>`
  const on = (sel, fn) => { const el = box.querySelector(sel); if (el) el.onclick = fn }
  on('#vpsEdit', () => { box.dataset.edit = '1'; renderVps() })
  on('#vpsCancel', () => { box.dataset.edit = ''; vpsFound = null; renderVps() })
  on('#copyUrl', () => copy(v.url))
  on('#sendAll', async () => {
    try { const r = await api('vps/send', { ids: 'all' }); toast(`开始发送 ${r.count} 课`); pollJobsNow() } catch (e) { toast(e.message) }
  })
  on('#vpsDetect', async () => {
    const host = box.querySelector('#vpsHost').value
    box.querySelector('#vpsFound').innerHTML = '<div class="faint" style="margin-top:8px">正在登录 VPS 查找…</div>'
    try {
      vpsFound = { host, ...(await api('vps/detect', { host })) }
      box.querySelector('#vpsFound').innerHTML = foundList(vpsFound)
      bindFound(box)
    } catch (e) { box.querySelector('#vpsFound').innerHTML = `<div class="small" style="color:var(--bad);margin-top:8px">${esc(e.message)}</div>` }
  })
  bindFound(box)
}

function foundList(f) {
  if (!f.instances.length) return '<div class="small" style="color:var(--bad);margin-top:8px">这台 VPS 上没找到正在运行的 DSH 网页版。先用 dsh-vps 装好 DSH。</div>'
  return `<div style="margin-top:10px">${f.instances.map((x, k) => `
    <div class="row inst">
      <div class="grow"><b>${esc(x.domain || `端口 ${x.port}`)}</b> <span class="faint">用户 ${esc(x.user)} · ${esc(x.home)}</span>
        <div class="faint">${x.hasPlugin ? '✓ 已装「听懂」插件' : '还没装「听懂」插件'}</div></div>
      <button class="btn primary" data-pick="${k}">用这个</button>
    </div>`).join('')}
    ${!f.root && f.instances.some(x => x.user !== f.sshUser) ? `<div class="faint">注意：SSH 用的是 ${esc(f.sshUser)}，和 DSH 的用户不同，可能没有权限写进去。</div>` : ''}</div>`
}

function bindFound(box) {
  box.querySelectorAll('[data-pick]').forEach(b => {
    b.onclick = async () => {
      const x = vpsFound.instances[Number(b.dataset.pick)]
      try {
        await api('vps/config', { host: vpsFound.host, user: x.user, home: x.home, domain: x.domain, port: x.port })
        vpsFound = null
        box.dataset.edit = ''
        toast('已保存')
        renderVps()
      } catch (e) { toast(e.message) }
    }
  })
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制') } catch { window.prompt('复制这个地址：', text) }
}

// ———————————————————— 一节课 ————————————————————

const TABS = [['overview', '概览'], ['study', '精听'], ['review', '复习'], ['text', '连续听'], ['drill', '磨耳朵'], ['words', '词汇']]

function renderLesson(tab) {
  const l = S.cur.lesson
  const ids = usable(l).map(s => s.i)
  const st = stats(ids, S.cur.progress.cards)
  app.innerHTML = `
    <div id="lessonJob"></div>
    <nav class="tabs">${TABS.map(([k, name]) => `<button class="tab ${k === tab ? 'on' : ''}" data-tab="${k}">${name}${k === 'review' && st.due ? ` <span class="badge">${st.due}</span>` : ''}</button>`).join('')}</nav>
    ${['study', 'review', 'text', 'drill'].includes(tab) && l.sentences && l.sentences.length ? voiceBar() : ''}
    <section id="pane"></section>`
  bindVoiceBar()
  app.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => go(`#/l/${l.id}/${b.dataset.tab}`) })
  const on = app.querySelector('.tab.on')
  if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' })
  renderJobs()
  const pane = $('#pane')
  if (!l.sentences || !l.sentences.length) {
    pane.innerHTML = `<div class="empty">${l.status === 'error' ? esc(l.error) : l.note ? esc(l.note) : '正在识别英文，稍等…'}</div>${manageButtons(l)}`
    bindManage(pane, l)
    return
  }
  ;({ overview: paneOverview, study: paneStudy, review: paneReview, text: paneText, drill: paneDrill, words: paneWords }[tab] || paneOverview)(pane, l, st)
}

/** 课程页上方的「声音」选择条 */
function voiceBar() {
  const t = curTrack()
  const have = TRACK_ORDER.filter(x => x === 'full' || S.cur.tracks[x])
  return `<div class="row voicebar"><span class="faint">声音</span>
    <select id="trackSel">${have.map(x => `<option value="${x}" ${x === t ? 'selected' : ''}>${esc(trackLabel(x))}${S.cur.tracks[x] && S.cur.tracks[x].voice ? ` · ${esc(S.cur.tracks[x].voice)}` : ''}</option>`).join('')}</select>
    ${have.length < TRACK_ORDER.length && S.status && S.status.ffmpeg ? '<a href="#" class="link" id="moreVoices">更多声音</a>' : ''}</div>`
}

function bindVoiceBar() {
  const sel = $('#trackSel')
  if (sel) sel.onchange = () => { useTrack(sel.value); render() }
  const more = $('#moreVoices')
  if (more) more.onclick = e => { e.preventDefault(); go(`#/l/${S.cur.lesson.id}/overview`); setTimeout(() => { const v = $('#voices'); if (v) v.scrollIntoView({ block: 'start' }) }, 50) }
}

function manageButtons(l) {
  const missing = (l.sentences || []).some(s => !s.zh && !s.skip) || (l.sentences.length && !l.summaryZh) || l.status === 'error' || l.status === 'paused'
  const canWork = !S.status || S.status.ffmpeg
  return `<div class="row" style="margin-top:10px">
    ${S.vps && S.vps.config && l.status === 'ready' ? `<button class="btn primary" data-act="send">发送到 VPS</button>` : ''}
    ${missing && canWork ? '<button class="btn" data-act="resume">补全翻译</button>' : ''}
    ${l.sentences && l.sentences.length && canWork ? '<button class="btn ghost" data-act="retranslate">重新翻译</button>' : ''}
    <button class="btn ghost" data-act="reset">重置进度</button>
    <button class="btn ghost danger" data-act="delete">删除这课</button>
  </div>`
}

function bindManage(root, l) {
  const ask = { retranslate: '用当前模型把整课重新翻译一遍？', reset: '清空这课的学习进度？（收藏的难句保留）', delete: '删除这节课（内容和进度）？原音频文件不受影响。' }
  root.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = async () => {
      const act = b.dataset.act
      if (ask[act] && !confirm(ask[act])) return
      try {
        if (act === 'send') { await api('vps/send', { ids: [l.id] }); toast('开始发送，进度在顶部'); pollJobsNow(); return }
        await api(act, { id: l.id })
        if (act === 'delete') { S.cur = null; S.cache.delete(l.id); await refreshLessons(); return go('#/') }
        if (act === 'reset') { store.set(`pos:${l.id}`, 0); toast('已重置') }
        else toast('已开始，进度在顶部')
        pollJobsNow()
        await loadLesson(l.id)
        render()
      } catch (e) { toast(e.message) }
    }
  })
}

function paneOverview(pane, l, st) {
  const pos = getPos()
  const stars = (S.cur.progress.stars || []).length
  pane.innerHTML = `
    <div class="card">
      ${l.titleZh ? `<div style="font-weight:600">${esc(l.titleZh)}</div><div class="faint">${esc(l.title)}</div>` : `<div style="font-weight:600">${esc(l.title)}</div>`}
      <div class="faint" style="margin-top:2px">${fmtDur(l.duration)} · ${l.sentences.length} 句${l.model ? ` · 翻译：${esc(l.model)}` : ''}</div>
      ${l.summaryZh ? `<p class="summary">${esc(l.summaryZh)}</p>` : ''}
      ${l.note ? `<div class="small" style="color:var(--mid)">${esc(l.note)}</div>` : ''}
      ${l.status === 'error' ? `<div class="small" style="color:var(--bad)">${esc(l.error)}</div>` : ''}
    </div>
    <div class="card">
      <div class="stat-grid">
        <div><b>${st.fresh}</b><span>没学过</span></div>
        <div><b>${st.learning}</b><span>学习中</span></div>
        <div><b style="color:var(--good)">${st.mastered}</b><span>已掌握</span></div>
        <div><b style="color:var(--accent)">${st.due}</b><span>待复习</span></div>
      </div>
      <div class="bar good"><i style="width:${st.total ? Math.round(st.mastered / st.total * 100) : 0}%"></i></div>
      <div class="row" style="margin-top:12px">
        <button class="btn primary big" id="goStudy">${pos > 0 ? `继续精听（第 ${pos + 1} 句）` : '开始精听'}</button>
        <button class="btn big" id="goReview" ${st.due || st.fresh ? '' : 'disabled'}>复习${st.due ? ` ${st.due} 句` : ''}</button>
        <button class="btn big" id="goDrill">磨耳朵</button>
      </div>
      ${!st.due && st.nextDue ? `<div class="faint" style="margin-top:6px">下一批复习：${when(st.nextDue)}</div>` : ''}
      ${stars ? `<div class="faint" style="margin-top:6px">难句本：收藏了 ${stars} 句，在「复习」或「磨耳朵」里选「收藏」专门练。</div>` : ''}
    </div>
    ${voicesCard(l)}
    ${zhCard(l)}
    <div class="card">
      <h3>怎么练到「一听就懂」</h3>
      <ol class="steps">
        <li><b>精听</b>：每句先<b>只听不看</b>，猜意思 → 看英文，找出没听出来的词（点词看意思）→ 看中文和生词 → 再听一遍。</li>
        <li>老实自评：<span class="g0">没听懂</span> / <span class="g1">半懂</span> / <span class="g2">听懂了</span>；拿不准的点 ☆ 收进难句本。</li>
        <li><b>复习</b>：只放声音。可以自评，也可以「选意思」「听写」，更客观。没听懂的一会儿再来，听懂的隔几天再考，7 天后还能听懂算掌握。</li>
        <li><b>磨耳朵</b>：走路通勤时戴耳机，每句自动放几遍、停一下让你想意思；锁屏也能放。</li>
        <li><b>连续听</b>：选「原声·去空白」一句接一句不停地听；先用朗读的声音听清每个词，再回到原声；最后关掉字幕，能跟上就是真听懂了。</li>
      </ol>
      <div class="faint" style="margin-top:6px">电脑快捷键：空格 重听 · 回车 下一步 · 1/2/3 评分 · ←/→ 换句 · S 变速 · L 循环。手机上左右滑动换句。</div>
    </div>
    <div class="card"><h3>管理</h3>${manageButtons(l)}</div>`
  bindVoices(pane, l)
  bindZh(pane, l)
  $('#goStudy').onclick = () => go(`#/l/${l.id}/study`)
  $('#goReview').onclick = () => go(`#/l/${l.id}/review`)
  $('#goDrill').onclick = () => go(`#/l/${l.id}/drill`)
  bindManage(pane, l)
}

// —— 概览里的「声音」卡片：每种声音一行：状态、选用、试听、生成、下载 ——
const TRACK_NOTES = {
  full: '原始音频，含背景音乐和长空白',
  clean: '只留讲话，句间停 0.7 秒，不用等',
  cleannr: '只留讲话，再滤掉低沉的双耳节拍和高频噪声',
  say: 'macOS 自带语音朗读校对后的英文',
  kokoro: '离线神经网络语音，接近真人',
}

function voicesCard(l) {
  if (!l.sentences || !l.sentences.length) return ''
  const t = curTrack()
  const v = S.voices || {}
  const canMake = !S.status || S.status.ffmpeg
  const busy = name => S.jobs.find(j => j.lessonId === l.id && j.kind === 'track' && j.track === name && (j.state === 'running' || j.state === 'queued'))
  const opts = (list, sel) => list.map(x => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x.label)}</option>`).join('')
  const speeds = sel => [0.8, 0.9, 1].map(x => `<option value="${x}" ${x === sel ? 'selected' : ''}>${x === 1 ? '正常语速' : x + ' 倍语速'}</option>`).join('')
  const row = name => {
    const meta = name === 'full' ? { duration: l.duration } : S.cur.tracks[name]
    if (!meta && !canMake) return ''
    const job = busy(name)
    const tts = name === 'say' || name === 'kokoro'
    const sayList = v.say || []
    if (name === 'say' && !sayList.length && !meta) return ''
    const stale = meta && name !== 'full' && l.editedAt && meta.createdAt < l.editedAt
    const voiceSel = tts && canMake ? `<select data-voice="${name}">${name === 'kokoro'
      ? opts(((v.kokoro && v.kokoro.voices) || []), (meta && meta.voice) || 'am_michael')
      : opts(sayList, (meta && meta.voice) || (sayList[0] && sayList[0].id))}</select>
      <select data-speed="${name}">${speeds((meta && meta.speed) || 0.9)}</select>` : ''
    return `<div class="track ${name === t ? 'on' : ''}">
      <div class="row"><b class="grow">${esc(trackLabel(name))}</b>
        ${meta ? `<span class="faint">${fmt(meta.duration)}${meta.voice ? ' · ' + esc(meta.voice) : ''}</span>` : '<span class="faint">未生成</span>'}</div>
      <div class="faint">${TRACK_NOTES[name]}${name === 'kokoro' && v.kokoro && !v.kokoro.ready && canMake ? '；第一次生成会下载约 103 MB 语音模型' : ''}</div>
      ${stale ? '<div class="small" style="color:var(--mid)">句子改过了，这条声音对不上了，建议重新生成</div>' : ''}
      ${job ? `<div class="small muted" style="margin-top:4px">${job.state === 'queued' ? '排队中' : esc(job.stage)}${job.total ? ` ${job.done}/${job.total}` : ''}…</div>` : `
      <div class="row" style="margin-top:6px">
        ${meta ? (name === t ? '<span class="badge ok">正在用</span>' : `<button class="btn" data-use="${name}">选用</button>`) : ''}
        ${meta ? `<button class="btn ghost" data-try="${name}">▶ 试听</button>` : ''}
        ${meta ? `<a class="btn ghost" href="audio?id=${encodeURIComponent(l.id)}&track=${name}&download=1" download>下载 MP3</a>` : ''}
        ${voiceSel}
        ${name !== 'full' && canMake ? `<button class="btn ${meta ? 'ghost' : 'primary'}" data-make="${name}">${meta ? '重新生成' : '生成'}</button>` : ''}
      </div>`}
    </div>`
  }
  return `<div class="card" id="voices"><h3>声音</h3>
    <div class="faint" style="margin-bottom:6px">同样的句子，换一种声音听。去空白和朗读的声音都可以不停顿地连续听，也能下载到手机。</div>
    ${TRACK_ORDER.map(row).join('')}
    ${canMake && v.sayHint && (v.say || []).length && (v.say || []).every(x => x.quality < 2) ? `<div class="faint" style="margin-top:8px">💡 ${esc(v.sayHint)}</div>` : ''}
  </div>`
}

function bindVoices(root, l) {
  root.querySelectorAll('[data-use]').forEach(b => { b.onclick = () => { useTrack(b.dataset.use); render() } })
  root.querySelectorAll('[data-try]').forEach(b => {
    b.onclick = () => {
      useTrack(b.dataset.try)
      const first = usable(l).find(x => tm(x))
      if (first) playSentence(first)
      root.querySelectorAll('.track').forEach(el => el.classList.remove('on'))
      b.closest('.track').classList.add('on')
    }
  })
  root.querySelectorAll('[data-make]').forEach(b => {
    b.onclick = async () => {
      const name = b.dataset.make
      const voice = root.querySelector(`[data-voice="${name}"]`)
      const speed = root.querySelector(`[data-speed="${name}"]`)
      b.disabled = true
      try {
        await api('track', { id: l.id, track: name, voice: voice ? voice.value : undefined, speed: speed ? Number(speed.value) : undefined })
        toast('已开始生成，进度在顶部')
        S.jobs = (await api('jobs')).jobs
        render()
      } catch (e) { toast(e.message); b.disabled = false }
    }
  })
}

// —— 导出：中文配音（只有中文、没有背景音，每句放在对应英文的时间上）和文字（字幕 / 歌词 / 录音稿） ——
let zhAudio = null // 试听用的独立播放器，不打扰课程的播放器
function stopZhAudio() { if (zhAudio) { zhAudio.pause(); zhAudio = null } }
window.addEventListener('hashchange', stopZhAudio)

const TEXT_FORMATS = [['srt-bi', '双语字幕'], ['srt-en', '英文字幕'], ['srt-zh', '中文字幕'], ['lrc', '歌词 LRC'], ['script', '录音稿'], ['csv', '表格']]

function zhCard(l) {
  if (!l.sentences || !l.sentences.length) return ''
  const meta = S.cur.tracks.zh
  const canMake = !S.status || S.status.ffmpeg
  const V = S.voices || {}
  const engine = store.get('zhEngine', (meta && meta.engine) || 'kokoro')
  const list = engine === 'edge' ? ((V.edge && V.edge.voices) || []) : ((V.zh && V.zh.voices) || [])
  const job = S.jobs.find(j => j.lessonId === l.id && j.kind === 'track' && j.track === 'zh' && (j.state === 'running' || j.state === 'queued'))
  const selKey = engine === 'edge' ? 'zhVoiceEdge' : 'zhVoice'
  const sel = (meta && meta.engine === engine && meta.voice) || store.get(selKey, list[0] && list[0].id)
  const speed = (meta && meta.speed) || store.get('zhSpeed', 1)
  const clean = S.cur.tracks.clean
  const align = store.get('zhAlign', (meta && meta.align) || 'full')
  const group = (g, name) => `<optgroup label="${name}">${list.filter(x => x.gender === g).map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</optgroup>`
  const edgeMissing = engine === 'edge' && !(V.edge && V.edge.ready)
  const alignChips = attr => `<button class="chip ${align === 'full' ? 'on' : ''}" data-${attr}="full">原音频（${fmt(l.duration)}）</button>
    ${clean ? `<button class="chip ${align === 'clean' ? 'on' : ''}" data-${attr}="clean">原声·去空白（${fmt(clean.duration)}）</button>` : ''}`
  return `<div class="card" id="zhCard"><h3>导出</h3>
    <div class="sub-h">中文配音（音频）</div>
    <div class="faint">只有中文、没有背景音，每句中文从对应英文开始的时刻开始说；比空档长的句子会读快一点，不会挤到下一句。</div>
    ${meta ? `<div class="row" style="margin-top:8px"><span class="badge ok">已生成</span><span class="faint grow">${esc(meta.voiceLabel || meta.voice)} · ${meta.align === 'clean' ? '对齐原声·去空白' : '对齐原音频'} · ${fmt(meta.duration)}${meta.squeezed ? ` · ${meta.squeezed} 句读快了一点` : ''}</span></div>
      <div class="row" style="margin-top:6px">
        <button class="btn" id="zhPlay">▶ 试听</button>
        <a class="btn primary" href="audio?id=${encodeURIComponent(l.id)}&track=zh&download=1" download>下载 MP3</a>
      </div>` : ''}
    ${job ? `<div class="small muted" style="margin-top:8px">${job.state === 'queued' ? '排队中' : esc(job.stage)}${job.total ? ` ${job.done}/${job.total}` : ''}…</div>` : canMake ? `
      <div class="form">
        <label>语音</label><div class="chips">
          <button class="chip ${engine === 'kokoro' ? 'on' : ''}" data-zhengine="kokoro">本地 Kokoro（100 种，离线）</button>
          <button class="chip ${engine === 'edge' ? 'on' : ''}" data-zhengine="edge">微软 Edge（14 种，要联网）</button>
        </div>
        ${edgeMissing ? `<label></label><div><div class="faint">Edge 语音要先装一个小组件（edge-tts，约 15 MB，装在插件自己的目录里，需要电脑上有 Python 3）。用的时候中文会发到微软的服务器；这不是微软公开的正式接口，以后可能失效。</div>
          <button class="btn" id="edgeInstall" style="margin-top:6px">安装 Edge 语音组件</button></div>` : `
        <label>音色</label><div class="row"><select id="zhVoice">${group('f', '女声')}${group('m', '男声')}</select><button class="btn ghost" id="zhTry">试听这个音色</button></div>
        <label>语速</label><div class="chips">${[0.9, 1, 1.1].map(x => `<button class="chip ${x === speed ? 'on' : ''}" data-zhspeed="${x}">${x === 1 ? '正常' : x < 1 ? '慢一点' : '快一点'}</button>`).join('')}</div>
        <label>时间对齐</label><div class="chips">${alignChips('zhalign')}</div>`}
      </div>
      ${edgeMissing ? '' : `<div class="faint" style="margin:6px 0 10px">对齐原音频：总长和原音频一样，可以和原音频对着听；对齐去空白：和「原声·去空白」一句对一句。${engine === 'kokoro' && !(V.zh && V.zh.ready) ? '第一次会先下载约 147 MB 中文语音模型。' : ''}${engine === 'edge' && V.edge && V.edge.version ? ` Edge 组件 ${esc(V.edge.version)}，<a href="#" class="link" id="edgeUpdate">更新</a>。` : ''}</div>
      <button class="btn ${meta ? 'ghost' : 'primary'}" id="zhMake">${meta ? '换音色重新生成' : '生成中文配音'}</button>`}` : ''}
    <div class="sub-h" style="margin-top:16px">文字（字幕 / 歌词 / 录音稿）</div>
    <div class="faint">英文原文和中文对译，带时间。想自己录中文配音，就下载「录音稿」：每句标了开始时间和可用时长。</div>
    <div class="form">
      <label>时间按</label><div class="chips">${alignChips('txalign')}</div>
      <label>下载</label><div class="row wrap">${TEXT_FORMATS.map(([f, name]) => `<a class="btn ghost" data-fmt="${f}" href="export?id=${encodeURIComponent(l.id)}&format=${f}&align=${align}" download>${name}</a>`).join('')}</div>
    </div>
  </div>`
}

function bindZh(root, l) {
  const card = root.querySelector('#zhCard')
  if (!card) return
  const engine = () => store.get('zhEngine', (S.cur.tracks.zh && S.cur.tracks.zh.engine) || 'kokoro')
  let speed = (S.cur.tracks.zh && S.cur.tracks.zh.speed) || store.get('zhSpeed', 1)
  const rerender = () => { const box = document.createElement('div'); box.innerHTML = zhCard(l); card.replaceWith(box.firstElementChild); bindZh(root, l) }
  card.querySelectorAll('[data-zhengine]').forEach(b => { b.onclick = () => { store.set('zhEngine', b.dataset.zhengine); stopZhAudio(); rerender() } })
  card.querySelectorAll('[data-zhspeed]').forEach(b => {
    b.onclick = () => { speed = Number(b.dataset.zhspeed); store.set('zhSpeed', speed); card.querySelectorAll('[data-zhspeed]').forEach(x => x.classList.toggle('on', x === b)) }
  })
  // 两处「时间对齐」共用一个选择
  card.querySelectorAll('[data-zhalign],[data-txalign]').forEach(b => {
    b.onclick = () => { store.set('zhAlign', b.dataset.zhalign || b.dataset.txalign); rerender() }
  })
  const voiceSel = card.querySelector('#zhVoice')
  if (voiceSel) voiceSel.onchange = () => store.set(engine() === 'edge' ? 'zhVoiceEdge' : 'zhVoice', voiceSel.value)
  const install = async (btn) => {
    btn.disabled = true
    const old = btn.textContent
    btn.textContent = '正在安装…（第一次要一两分钟）'
    try {
      const r = await api('edge/install', {})
      toast(r.ready ? `Edge 语音组件已装好（${r.version}）` : '安装没成功')
      S.voices = null
      await loadLesson(l.id)
      rerender()
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = old }
  }
  const inst = card.querySelector('#edgeInstall')
  if (inst) inst.onclick = () => install(inst)
  const upd = card.querySelector('#edgeUpdate')
  if (upd) upd.onclick = e => { e.preventDefault(); install(upd) }
  const tryBtn = card.querySelector('#zhTry')
  if (tryBtn) tryBtn.onclick = async () => {
    stopZhAudio()
    player.stop()
    tryBtn.disabled = true
    const first = engine() === 'kokoro' && !(S.voices && S.voices.zh && S.voices.zh.ready)
    tryBtn.textContent = first ? '第一次要下载中文语音模型，稍等…' : '正在生成试听…'
    try {
      const r = await fetch('voice-sample', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-tingdong': '1' }, body: JSON.stringify({ engine: engine(), voice: voiceSel.value }) })
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || `试听失败（${r.status}）`)
      zhAudio = new Audio(URL.createObjectURL(await r.blob()))
      zhAudio.play()
      if (first && S.voices && S.voices.zh) S.voices.zh.ready = true
    } catch (e) { toast(e.message) }
    tryBtn.disabled = false
    tryBtn.textContent = '试听这个音色'
  }
  const play = card.querySelector('#zhPlay')
  if (play) play.onclick = () => {
    if (zhAudio && !zhAudio.paused) { stopZhAudio(); play.textContent = '▶ 试听'; return }
    player.stop()
    const meta = S.cur.tracks.zh
    const first = Math.min(...Object.values(meta.items).map(x => x[0]))
    zhAudio = new Audio(`audio?id=${encodeURIComponent(l.id)}&track=zh&v=${meta.createdAt}`)
    zhAudio.currentTime = Math.max(0, first - 0.3)
    zhAudio.play().catch(() => toast('播放失败'))
    zhAudio.onpause = () => { play.textContent = '▶ 试听' }
    play.textContent = '❚❚ 停止'
  }
  const make = card.querySelector('#zhMake')
  if (make) make.onclick = async () => {
    make.disabled = true
    try {
      await api('track', { id: l.id, track: 'zh', engine: engine(), voice: voiceSel.value, speed, align: store.get('zhAlign', 'full') })
      toast('已开始生成中文配音，进度在顶部')
      S.jobs = (await api('jobs')).jobs
      render()
    } catch (e) { toast(e.message); make.disabled = false }
  }
}

// ———————————————————— 启动 ————————————————————

;(async () => {
  try { S.status = await api('status') } catch { S.status = null }
  await refreshLessons()
  render()
  pollJobs()
})()
