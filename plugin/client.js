/* global window, document */
// plugin/client.js — 听懂在 DSH 界面里的入口
//
// 手写单文件 bundle，没有构建链：由 dsh web 客户端的 ModuleLoader 注入（写法照 dsh-pick）。挂两处：
//   - 对话页右侧栏的一个页签：整个学习面板（iframe 指向宿主路由 /api-dsh-tingdong/panel）
//   - 「设置 → 听懂」：状态（ffmpeg、识别模型、翻译模型）和用法
// 面板本身是独立调好的页面（dsh-tingdong serve 也能直接打开），这里原样复用。
// 硬约束：界面崩了不能影响 dsh，注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'dsh-tingdong',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const PANEL = '/api-dsh-tingdong/panel'
    const SIDEBAR_TAB_ID = 'dsh-tingdong/panel'
    const SIDEBAR_KIND = 'dsh-tingdong'

    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      sub: 'var(--dsw-alias-label-secondary, #888)',
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,.25))',
      good: '#1f9d55',
      warn: '#c98a12',
    }

    function Btn({ onClick, children }) {
      return h('button', {
        type: 'button', onClick,
        style: {
          appearance: 'none', fontFamily: 'inherit', fontSize: 12, lineHeight: '18px', padding: '2px 10px',
          borderRadius: 6, cursor: 'pointer', border: '1px solid ' + C.border, background: 'transparent', color: C.text,
        },
      }, children)
    }

    /** 右侧栏：占满栏高的 iframe */
    function Panel() {
      return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' } },
        h('iframe', {
          src: PANEL,
          title: '听懂',
          allow: 'autoplay',
          style: { width: '100%', flex: '1 1 0', minHeight: 0, border: 0, display: 'block', background: 'transparent' },
        }))
    }

    let sidebarRightApi = null

    function Line({ ok, children }) {
      return h('div', { style: { fontSize: 12.5, lineHeight: 1.8 } },
        h('span', { style: { color: ok ? C.good : C.warn, marginRight: 6 } }, ok ? '✓' : '!'), children)
    }

    function SettingsSection() {
      const [st, setSt] = useState(null)
      const [msg, setMsg] = useState('')
      useEffect(() => {
        let alive = true
        fetch('/api-dsh-tingdong/status', { credentials: 'same-origin' }).then(r => r.json()).then(j => { if (alive) setSt(j) }).catch(() => {})
        return () => { alive = false }
      }, [])
      const open = () => {
        try { sidebarRightApi.openTab(SIDEBAR_KIND); setMsg('已在右侧栏打开，关闭设置就能看到') }
        catch { setMsg('先回到一个对话，再从右侧栏打开') }
      }
      return h('div', { style: { color: C.text } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: 15, fontWeight: 650 } }, '听懂'),
          st && st.version ? h('span', { style: { fontSize: 12, color: C.sub } }, 'v' + st.version) : null),
        h('div', { style: { fontSize: 12.5, color: C.sub, lineHeight: 1.7, marginTop: 6 } },
          '把英文有声读物（MP3）变成听力课：本机识别每一句英文，AI 翻译讲解，再用盲听、精听、间隔复习练到一听就懂。'),
        h('div', { style: { marginTop: 14 } },
          !st ? h('div', { style: { fontSize: 12, color: C.sub } }, '正在检查…') : [
            h(Line, { key: 'f', ok: st.ffmpeg }, st.ffmpeg ? 'ffmpeg 已找到' : '找不到 ffmpeg：Mac 上执行 brew install ffmpeg，或在插件配置里填 ffmpeg 路径'),
            h(Line, { key: 'm', ok: st.models }, st.models ? '语音识别模型已就绪（本机识别，不上传音频）' : '第一次导入时会下载语音识别模型（约 240 MB）'),
            h(Line, { key: 'l', ok: Boolean(st.llm) }, st.llm ? `翻译讲解用：${st.llm}（DSH 的默认模型，可在插件配置里改）` : '没有可用的模型：先在 DSH 里选一个默认模型'),
          ]),
        h('div', { style: { fontSize: 13, fontWeight: 600, marginTop: 18, marginBottom: 6 } }, '怎么打开'),
        h('div', { style: { fontSize: 12.5, color: C.sub, lineHeight: 1.7 } },
          '学习面板在对话页的右侧栏：打开右侧栏，选「听懂」。也可以在对话里直接说「把 <文件夹路径> 导入听懂」。'),
        sidebarRightApi ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
          h(Btn, { onClick: open }, '在右侧栏打开'),
          h(Btn, { onClick: () => window.open(PANEL, '_blank') }, '新窗口打开'),
          msg ? h('span', { style: { fontSize: 12, color: C.sub } }, msg) : null) : null,
      )
    }

    function EarIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 32 32', fill: 'none' },
        h('path', {
          d: 'M10 13a7 7 0 1 1 14 0c0 4-3 5-4 8s-2 5-5 5a4 4 0 0 1-4-3M14 13a3 3 0 1 1 6 0c0 2-2 2.5-2 4',
          stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    function apply(ctx) {
      try {
        ctx.inject && ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          const right = (scope.get && scope.get('sidebarRight')) || scope.sidebarRight
          const tabs = (scope.get && scope.get('sidebarRightTabs')) || scope.sidebarRightTabs
          if (!tabs || typeof tabs.register !== 'function') return
          const effect = (fn, label) => (scope.effect ? scope.effect(fn, label) : fn())
          effect(() => tabs.register({
            id: SIDEBAR_TAB_ID,
            kind: SIDEBAR_KIND,
            priority: 'extension',
            keepMounted: true,
            title: () => '听懂',
            guide: [{
              id: 'dsh-tingdong',
              order: 60,
              title: () => '听懂 · 英文听力',
              description: () => '导入英文 MP3，逐句练到一听就懂',
              icon: EarIcon,
            }],
          }), 'dsh-tingdong: sidebar type')
          const slots = scope.slots || ctx.slots
          const body = () => slots.register({ name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_ID }, Panel)
          effect(() => (slots.inject ? slots.inject('sidebar.right.pane.tab', body) : body()), 'dsh-tingdong: sidebar body')
          if (right && typeof right.openTab === 'function') {
            sidebarRightApi = right
            effect(() => () => { if (sidebarRightApi === right) sidebarRightApi = null }, 'dsh-tingdong: sidebar api')
          }
        })
      } catch (error) {
        console.warn('[dsh-tingdong] 右侧栏注册失败', error)
      }
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-tingdong', order: 31, label: () => '听懂' }, SettingsSection))
      } catch (error) {
        console.warn('[dsh-tingdong] 设置页注册失败', error)
      }
    }

    module.exports = { name: 'dsh-tingdong', inject: ['slots'], apply }
    return module.exports
  },
})
