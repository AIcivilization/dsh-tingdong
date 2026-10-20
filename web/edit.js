// web/edit.js — 点词查意思；改句子（改字、合并、拆开、重新讲解、标为非讲话）

import { api, esc, loadLesson, S, toast } from './core.js'

// ———————————————————— 点词查意思 ————————————————————

let pop = null
function closePop() { if (pop) { pop.remove(); pop = null } }
document.addEventListener('click', e => { if (pop && !pop.contains(e.target) && !e.target.closest('.w')) closePop() })
window.addEventListener('hashchange', closePop)

/** 让一行英文里的词可以点（clickableEn 生成的 .w） */
export function bindWords(container, s) {
  container.querySelectorAll('.w').forEach(el => {
    el.onclick = async (e) => {
      e.stopPropagation()
      closePop()
      pop = document.createElement('div')
      pop.className = 'pop'
      pop.innerHTML = `<div class="row"><b>${esc(el.textContent)}</b><span class="faint">查询中…</span></div>`
      document.body.appendChild(pop)
      place(pop, el)
      const mine = pop
      try {
        const r = await api('lookup', { id: S.cur.lesson.id, i: s.i, word: el.textContent })
        if (pop !== mine) return
        pop.innerHTML = `<div class="row"><b>${esc(r.w)}</b><span class="faint">${esc(r.ipa)}</span>${r.pos ? `<span class="badge">${esc(r.pos)}</span>` : ''}</div>
          <div style="margin-top:4px">${esc(r.zh)}</div>${r.note ? `<div class="faint" style="margin-top:4px">${esc(r.note)}</div>` : ''}`
        place(pop, el)
      } catch (err) {
        if (pop === mine) pop.innerHTML = `<div class="small" style="color:var(--bad)">${esc(err.message)}</div>`
      }
    }
  })
}

function place(p, el) {
  const r = el.getBoundingClientRect()
  const w = Math.min(300, window.innerWidth - 24)
  p.style.width = w + 'px'
  p.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px'
  const below = r.bottom + 8
  p.style.top = (below + p.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - p.offsetHeight - 8) : below) + 'px'
}

// ———————————————————— 改句子 ————————————————————

/** 打开编辑面板；改完重新读课程，再调用 onDone */
export function openEditor(s, onDone) {
  closePop()
  const id = S.cur.lesson.id
  const sheet = document.createElement('div')
  sheet.className = 'sheet-wrap'
  const words = String(s.en || s.text).split(/\s+/).filter(Boolean)
  sheet.innerHTML = `<div class="sheet">
    <div class="row"><b class="grow">改这一句</b><button class="icon-btn" data-close aria-label="关闭">×</button></div>
    <label class="faint">英文（识别错了可以改）</label>
    <textarea id="edEn" rows="3">${esc(s.en || s.text)}</textarea>
    <label class="faint">中文</label>
    <textarea id="edZh" rows="2">${esc(s.zh || '')}</textarea>
    <div class="row" style="margin-top:8px">
      <button class="btn primary" data-act="save">保存</button>
      <button class="btn" data-act="explain" title="用大模型重新写中文、生词和听音提示">保存并重新讲解</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn ghost" data-act="merge">和下一句合并</button>
      <button class="btn ghost" data-act="split">拆成两句…</button>
      <button class="btn ghost danger" data-act="skip">这不是讲话</button>
    </div>
    <div id="splitBox" hidden>
      <div class="faint" style="margin:8px 0 4px">点第二句从哪个词开始：</div>
      <div class="split-words">${words.map((w, k) => `<button class="btn ghost" data-at="${k}" ${k ? '' : 'disabled'}>${esc(w)}</button>`).join('')}</div>
    </div>
    <div class="faint" style="margin-top:10px">合并、拆开以后，这一课生成过的声音需要重新生成才对得上。</div>
  </div>`
  document.body.appendChild(sheet)
  const close = () => sheet.remove()
  sheet.addEventListener('click', e => { if (e.target === sheet || e.target.closest('[data-close]')) close() })

  const done = async (msg) => {
    await loadLesson(id)
    close()
    if (msg) toast(msg)
    onDone && onDone()
  }
  const busy = on => sheet.querySelectorAll('button').forEach(b => { b.disabled = on })
  const run = async (fn, msg) => {
    busy(true)
    try { await fn(); await done(msg) } catch (e) { toast(e.message); busy(false) }
  }
  const val = sel => sheet.querySelector(sel).value
  sheet.querySelector('[data-act="save"]').onclick = () => run(() => api('edit', { id, i: s.i, en: val('#edEn'), zh: val('#edZh') }), '已保存')
  sheet.querySelector('[data-act="explain"]').onclick = () => run(async () => {
    await api('edit', { id, i: s.i, en: val('#edEn') })
    toast('正在重新讲解…')
    await api('explain', { id, ids: [s.i] })
  }, '已重新讲解')
  sheet.querySelector('[data-act="merge"]').onclick = () => run(() => api('merge', { id, i: s.i }), '已合并')
  sheet.querySelector('[data-act="skip"]').onclick = () => run(() => api('edit', { id, i: s.i, skip: true }), '已标为非讲话，不再出现在练习里')
  sheet.querySelector('[data-act="split"]').onclick = () => { sheet.querySelector('#splitBox').hidden = false }
  sheet.querySelectorAll('[data-at]').forEach(b => {
    b.onclick = () => run(async () => {
      const { sentences } = await api('split', { id, i: s.i, at: Number(b.dataset.at) })
      toast('已拆开，正在给两句重新讲解…')
      await api('explain', { id, ids: sentences.map(x => x.i) }).catch(e => toast(`讲解失败：${e.message}`))
    }, '已拆成两句')
  })
}
