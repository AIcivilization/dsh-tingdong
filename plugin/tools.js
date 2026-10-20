// plugin/tools.js — 给 DSH 对话里的 AI 用的 3 个工具
//
// 让用户在对话里说「把 /Volumes/…/CD4 导入听懂」「我哪些句子总听不懂？给我讲讲」，
// AI 自己导入、查进度、拿到难句（带中文、生词、听音提示）来讲解或出题。
// 直接写 DSH 工具注册表认的原始格式（标准 JSON Schema 子集），不依赖 defineTool：
// 插件包从自己的目录加载时 import 不到 @deepseek-ai/dsh-tools，而 {type:'json'} 这种简写只有 defineTool 认。

import { isMastered } from '../lib/srs.js'
import { checkId, getLesson, getProgress, listLessons } from '../lib/store.js'

const ANY_OBJECT = { type: 'object' }

/** {name: {type, description, required?, enum?}} → JSON Schema 的 object */
function params(spec) {
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(spec)) {
    const { required: req, ...rest } = v
    properties[k] = rest
    if (req) required.push(k)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}
const plain = v => JSON.parse(JSON.stringify(v == null ? null : v))
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

const OPEN_HINT = '学习面板在对话页的右侧栏：打开右侧栏，选「听懂」。'

/** 一句的文字版（给模型看） */
function sentenceLine(s, card) {
  const words = (s.words || []).map(w => `${w.w}${w.ipa ? ' ' + w.ipa : ''}=${w.zh}`).join('；')
  const state = !card ? '没学过' : isMastered(card) ? '已掌握' : `听过 ${card.seen} 次，没听懂 ${card.again} 次，最近一次：${['没听懂', '半懂', '听懂了'][card.lastGrade]}`
  return `#${s.i} [${mmss(s.start)}] ${s.en || s.text}\n  中文：${s.zh || '（未翻译）'}${words ? `\n  生词：${words}` : ''}${s.sound ? `\n  听音：${s.sound}` : ''}\n  进度：${state}`
}

/** 难度分：没听懂越多、最近越差越难 */
function hardness(card) {
  if (!card) return -1
  return card.again * 2 + (card.lastGrade === 0 ? 3 : card.lastGrade === 1 ? 1.5 : 0) - card.box
}

export async function buildToolDefinitions({ importer }) {
  return [
    {
      name: 'tingdong_import',
      description: '把本机的英文音频（MP3 等）或整个文件夹导入「听懂」，做成听力课：本地识别每一句英文，再翻译讲解。处理在后台进行。',
      parameters: params({
        path: { type: 'string', required: true, description: '音频文件或文件夹的完整路径；文件夹里的每个音频各做成一课' },
        title: { type: 'string', description: '课程标题（只导入一个文件时有效，可省略）' },
      }),
      output: {
        schema: ANY_OBJECT,
        render: (_a, v) => [{
          type: 'text',
          text: `${v.items.map(it => `- ${it.title}（${it.lessonId}）${it.existed ? '：已经导入过' : '：已加入处理队列'}`).join('\n')}\n` +
            `识别 + 翻译大约需要音频时长的 1/10 到 1/5。${OPEN_HINT}`,
        }],
      },
      async execute(args) {
        const items = await importer.importPath(String(args.path || ''), { title: typeof args.title === 'string' ? args.title : '' })
        return plain({ items })
      },
    },

    {
      name: 'tingdong_lessons',
      description: '列出「听懂」里的听力课和学习进度（掌握多少句、待复习多少句），以及正在处理的导入任务。',
      parameters: params({}),
      output: {
        schema: ANY_OBJECT,
        render: (_a, v) => [{
          type: 'text',
          text: (v.lessons.length
            ? v.lessons.map(l => `- ${l.titleZh || l.title}（id: ${l.id}）${l.status !== 'ready' ? ` [${l.status}]` : ''}：${mmss(l.duration)}，${l.sentences} 句；掌握 ${l.stats.mastered}/${l.stats.total}，学习中 ${l.stats.learning}，待复习 ${l.stats.due}`).join('\n')
            : '还没有课。') +
            (v.jobs.length ? `\n进行中的任务：\n${v.jobs.map(j => `- ${j.title}：${j.stage}${j.total ? ` ${j.done}/${j.total}` : ''}`).join('\n')}` : ''),
        }],
      },
      async execute() {
        return plain({ lessons: await listLessons(), jobs: importer.list().filter(j => j.state === 'running' || j.state === 'queued') })
      },
    },

    {
      name: 'tingdong_sentences',
      description: '取一节课的句子（校对后的英文、中文、生词、听音提示和用户的进度）。mode=hard 取用户最常听不懂的句子，适合帮用户讲解难点、出听力题；mode=range 按时间顺序取。',
      parameters: params({
        id: { type: 'string', required: true, description: '课程 id（用 tingdong_lessons 查）' },
        mode: { type: 'string', enum: ['hard', 'range'], description: '默认 hard' },
        from: { type: 'integer', description: 'mode=range 时从第几句开始（句子编号），默认 0' },
        limit: { type: 'integer', description: '最多几句，默认 12，最多 40' },
      }),
      output: {
        schema: ANY_OBJECT,
        render: (_a, v) => [{
          type: 'text',
          text: `${v.title}${v.summary ? `\n概述：${v.summary}` : ''}\n${v.mode === 'hard' ? '用户最常听不懂的句子：' : '句子：'}\n${v.lines.join('\n') || '（没有）'}` +
            (v.mode === 'hard' && !v.lines.length ? '\n用户还没在这课里标过「没听懂 / 半懂」。' : ''),
        }],
      },
      async execute(args) {
        const id = checkId(String(args.id || ''))
        const l = await getLesson(id)
        if (!l) throw new Error('没有这节课')
        const cards = (await getProgress(id)).cards || {}
        const limit = Math.min(40, Math.max(1, Number.parseInt(args.limit, 10) || 12))
        const all = (l.sentences || []).filter(s => !s.skip)
        let picked
        if (args.mode === 'range') {
          const from = Number.parseInt(args.from, 10) || 0
          picked = all.filter(s => s.i >= from).slice(0, limit)
        } else {
          picked = all.filter(s => { const c = cards[s.i]; return c && (c.lastGrade < 2 || c.again > 0) })
            .sort((a, b) => hardness(cards[b.i]) - hardness(cards[a.i]))
            .slice(0, limit)
        }
        return plain({
          title: l.titleZh ? `${l.titleZh}（${l.title}）` : l.title,
          summary: l.summaryZh || '',
          mode: args.mode === 'range' ? 'range' : 'hard',
          lines: picked.map(s => sentenceLine(s, cards[s.i])),
        })
      },
    },
  ]
}

/** 注册工具；有 effect 就交给它管理生命周期 */
export async function registerTools(tools, deps) {
  const defs = await buildToolDefinitions(deps)
  return defs.map(def => (deps.effect ? deps.effect(() => tools.register(def)) : tools.register(def)))
}
