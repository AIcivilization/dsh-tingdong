#!/usr/bin/env node
// bin/dsh-tingdong.js — 不开 DSH 也能用：导入音频、打开学习面板
//
//   dsh-tingdong import <文件或文件夹> [--title 标题]   识别 + 翻译，做成课
//   dsh-tingdong serve [--port 4810]                    在浏览器里打开学习面板
//   dsh-tingdong list                                   看有哪些课
//   dsh-tingdong voices <课程id|all> [--track clean,cleannr,say,kokoro] [--voice 名字] [--speed 0.9]
//                                                       生成声音轨（去空白原声 / 压背景 / 系统朗读 / Kokoro）
//
// 模型：--base-url / --api-key / --model，或环境变量 TINGDONG_BASE_URL / TINGDONG_API_KEY / TINGDONG_MODEL；
// 都没有就用本机的 dsh-model 网关。

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { cliLlm } from '../lib/cli-llm.js'
import { Importer } from '../lib/importer.js'
import { createHandler } from '../lib/server.js'
import { listLessons } from '../lib/store.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PREFIX = '/api-dsh-tingdong'

function parse(argv) {
  const flags = {}
  const rest = []
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]
    if (a.startsWith('--')) {
      const [key, val] = a.slice(2).split('=', 2)
      if (val !== undefined) flags[key] = val
      else if (argv[k + 1] && !argv[k + 1].startsWith('--')) flags[key] = argv[++k]
      else flags[key] = true
    } else rest.push(a)
  }
  return { flags, rest }
}

const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

async function main() {
  const { flags, rest } = parse(process.argv.slice(2))
  const cmd = rest.shift()
  const options = () => ({ ffmpeg: flags.ffmpeg, threads: Number(flags.threads) || 4 })

  if (cmd === 'list') {
    for (const l of await listLessons()) {
      const s = l.stats
      console.log(`${l.id}  ${l.titleZh || l.title}  [${l.status}]  ${fmtTime(l.duration)}  ${l.sentences} 句  掌握 ${s.mastered}/${s.total}  待复习 ${s.due}`)
    }
    return
  }

  if (cmd === 'voices') {
    const which = rest[0]
    if (!which) throw new Error('用法：dsh-tingdong voices <课程id|all> [--track clean,cleannr,say,kokoro]')
    const ids = which === 'all' ? (await listLessons()).filter(l => l.sentences).map(l => l.id) : [which]
    const tracks = String(typeof flags.track === 'string' ? flags.track : 'clean,cleannr,say,kokoro').split(',').map(x => x.trim()).filter(Boolean)
    const importer = new Importer({ llm: () => null, options, log: m => console.error(m) })
    let last = ''
    importer.onChange(() => {
      for (const j of importer.list()) {
        if (j.state !== 'running') continue
        const key = `${j.id}|${j.stage}|${j.total ? Math.floor(j.done / j.total * 4) : 0}`
        if (key !== last) { last = key; console.log(`${j.title}：${j.stage}${j.total ? ` ${j.done}/${j.total}` : ''}`) }
      }
    })
    for (const id of ids) for (const t of tracks) {
      await importer.makeTrack(id, t, { voice: typeof flags.voice === 'string' ? flags.voice : undefined, speed: flags.speed ? Number(flags.speed) : undefined })
    }
    await new Promise(resolve => {
      const check = () => { if (!importer.running && !importer.jobs.some(j => j.state === 'queued')) resolve() }
      importer.onChange(() => setImmediate(check))
      check()
    })
    for (const j of importer.list()) console.log(`${j.state === 'done' ? '✓' : '✗'} ${j.title}${j.error ? '：' + j.error : ''}`)
    return
  }

  if (cmd === 'import') {
    if (!rest[0]) throw new Error('用法：dsh-tingdong import <文件或文件夹>')
    const llm = await cliLlm(flags)
    console.log(llm ? `翻译模型：${llm.label()}（${llm.via}）` : '没有可用的大模型：只做英文识别，之后用 serve 打开面板点「补全翻译」')
    const importer = new Importer({ llm: () => llm, options, log: m => console.error(m) })
    // 只在换阶段、或进度每过 20% 时打一行
    let last = ''
    importer.onChange(() => {
      for (const j of importer.list()) {
        if (j.state !== 'running') continue
        const step = j.total ? Math.floor(j.done / j.total * 5) : 0
        const key = `${j.id}|${j.stage}|${step}`
        if (key === last) continue
        last = key
        console.log(`${j.title}：${j.stage}${j.total ? ` ${j.done}/${j.total} ${j.message || ''}` : ''}`)
      }
    })
    const items = await importer.importPath(rest[0], { title: typeof flags.title === 'string' ? flags.title : '' })
    for (const it of items) if (it.existed) console.log(`已经导入过：${it.title}（${it.lessonId}）`)
    await new Promise(resolve => {
      const check = () => { if (!importer.running && !importer.jobs.some(j => j.state === 'queued')) resolve() }
      importer.onChange(() => setImmediate(check))
      check()
    })
    for (const j of importer.list()) console.log(`${j.state === 'done' ? '✓' : '✗'} ${j.title}${j.error ? '：' + j.error : ''}`)
    for (const l of await listLessons()) if (items.some(it => it.lessonId === l.id)) {
      console.log(`  ${l.titleZh || l.title}：${l.sentences} 句，已翻译 ${l.translated}${l.note ? '；' + l.note : ''}`)
    }
    return
  }

  if (cmd === 'serve') {
    const llm = await cliLlm(flags)
    const importer = new Importer({ llm: () => llm, options, log: m => console.error(m) })
    const handle = createHandler({
      prefix: PREFIX, pkgRoot: PKG_ROOT, importer, options,
      status: () => ({ host: 'cli', llm: llm ? llm.label() : '' }),
    })
    const port = Number(flags.port) || 4810
    const server = createServer((req, res) => {
      if (req.url === '/' || req.url === '') { res.writeHead(302, { location: PREFIX + '/panel' }); return res.end() }
      if (!String(req.url).startsWith(PREFIX)) { res.writeHead(404); return res.end() }
      handle(req, res)
    })
    server.listen(port, '127.0.0.1', () => {
      console.log(`学习面板：http://127.0.0.1:${port}${PREFIX}/panel`)
      console.log(llm ? `翻译模型：${llm.label()}（${llm.via}）` : '没有可用的大模型：导入后只有英文')
    })
    return
  }

  console.log(`听懂 dsh-tingdong — 把英文有声读物变成听力课

  dsh-tingdong import <文件或文件夹> [--title 标题]
  dsh-tingdong serve [--port 4810]
  dsh-tingdong list
  dsh-tingdong voices <课程id|all> [--track clean,cleannr,say,kokoro] [--voice 名字] [--speed 0.9]

  模型：--base-url URL --api-key KEY --model ID（或 TINGDONG_BASE_URL / TINGDONG_API_KEY / TINGDONG_MODEL）
  其他：--ffmpeg <ffmpeg 路径>  --threads <识别线程数，默认 4>`)
}

main().catch(e => { console.error(e.message || e); process.exit(1) })
