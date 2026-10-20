// lib/translate.js — 让大模型把识别出的英文变成课：校对、翻译、生词、听音提示
//
// 一次送 ~20 句（带上前几句做上下文），要求只回 JSON。解析不了或缺句的，缩小批次再试一次；
// 还不行就留空，课照样能用，界面上可以「补全翻译」。

const SYSTEM = `你是一位英语听力老师，学生的母语是汉语。学生在听一段英文有声读物，目标是「听到英文就知道意思」。
给你的是语音识别出的英文句子（带编号），识别可能有错。对每一句：
1. en：校对后的英文。只改明显的识别错误（结合上下文和常识，例如专有名词、同音词），补好大小写和标点；不要改写原话。
2. zh：自然、口语化的中文意思，让学生一看就懂这句话在说什么。
3. words：这句里值得学的词或短语，0~4 个，优先选学生可能听不出来或不认识的（专有名词、短语动词、习惯说法）。
   每个是 {"w":"英文","ipa":"美式音标","zh":"在这句里的意思"}。很简单的词（the, you, now）不要列。
4. sound：一句中文的听音提示：这句话实际听起来哪里难（连读、弱读、吞音、语速、重音），例如「follow that with 连成一串，that 弱读成 /ðət/」。没什么特别的就给 ""。
5. skip：如果这一句其实不是讲话（音乐里的杂音、被误识别的单个词），给 true，其余情况给 false。

只输出一个 JSON 对象，不要任何解释或 Markdown 代码块：
{"items":[{"i":编号,"en":"…","zh":"…","words":[…],"sound":"…","skip":false}, …]}
每个编号都要有，顺序和输入一致。`

const SUMMARY_SYSTEM = `你是一位英语听力老师，学生的母语是汉语。下面是一段英文有声读物的全文（已校对）。请给出：
- title_zh：这段内容的中文标题（10 字左右）
- summary_zh：3~5 句中文概述：讲了什么、怎么进行的，让学生在听之前先知道大意
- terms：全篇反复出现或理解全文必须知道的关键术语/短语，最多 15 个，每个 {"w":"英文","ipa":"美式音标","zh":"中文","explain":"一句中文解释"}
只输出一个 JSON 对象：{"title_zh":"…","summary_zh":"…","terms":[…]}，不要任何解释或 Markdown 代码块。`

/** 从模型回复里抠出 JSON 对象（容忍 ```json 包裹、前后的废话） */
export function extractJson(text) {
  const s = String(text || '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON')
  return JSON.parse(s.slice(start, end + 1))
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** 把模型给的一项洗干净，字段缺了就给空值 */
export function cleanItem(raw) {
  const words = Array.isArray(raw.words) ? raw.words : []
  return {
    en: str(raw.en, 2000),
    zh: str(raw.zh, 2000),
    words: words
      .filter(w => w && typeof w.w === 'string' && w.w.trim())
      .slice(0, 6)
      .map(w => ({ w: str(w.w, 120), ipa: str(w.ipa, 160), zh: str(w.zh, 200) })),
    sound: str(raw.sound, 400),
    skip: raw.skip === true,
  }
}

function batchPrompt(context, items, hint) {
  const lines = []
  if (hint) lines.push(`材料：${hint}`)
  if (context.length) {
    lines.push('前文（仅供参考，不用输出）：')
    for (const c of context) lines.push(`- ${c}`)
  }
  lines.push('需要处理的句子：')
  for (const it of items) lines.push(`${it.i}. ${it.text}`)
  return lines.join('\n')
}

/** 跑一批；返回 Map<i, item>（可能缺一些） */
async function runBatch(llm, items, context, hint, signal) {
  const text = await llm.complete({ system: SYSTEM, user: batchPrompt(context, items, hint), maxTokens: 16000, signal })
  const json = extractJson(text)
  const got = new Map()
  for (const raw of Array.isArray(json.items) ? json.items : []) {
    const i = Number(raw && raw.i)
    if (items.some(it => it.i === i)) got.set(i, cleanItem(raw))
  }
  return got
}

/** 并发跑一组任务，最多 n 个同时 */
async function pool(tasks, n) {
  let next = 0
  const workers = Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (next < tasks.length) { const t = tasks[next++]; await t() }
  })
  await Promise.all(workers)
}

/**
 * 翻译还没翻译的句子（sentence.zh 为空的）。就地写进 sentences。
 * @param {object} llm complete() 接口
 * @param {{i:number,text:string,en?:string,zh?:string}[]} sentences
 * @param {object} opt { hint?, batchSize?, concurrency?, signal?, onProgress?(done,total), onBatch?() }
 * @returns {Promise<{failed:number, errors:string[]}>}
 */
export async function translateSentences(llm, sentences, opt = {}) {
  const size = opt.batchSize || 20
  const todo = sentences.filter(s => !s.zh && !s.skip)
  const total = todo.length
  let done = 0
  const errors = []
  const batches = []
  for (let k = 0; k < todo.length; k += size) batches.push(todo.slice(k, k + size))

  const apply = (s, item) => {
    s.en = item.en || s.text
    s.zh = item.zh
    s.words = item.words
    s.sound = item.sound
    s.skip = item.skip
  }
  const contextFor = first => {
    const idx = sentences.indexOf(first)
    return sentences.slice(Math.max(0, idx - 3), idx).map(s => s.en || s.text)
  }

  await pool(batches.map(batch => async () => {
    let missing = batch
    for (let attempt = 0; attempt < 3 && missing.length; attempt++) {
      // 第一次整批；之后把缺的拆成小批再试
      const parts = attempt === 0 ? [missing] : chunk(missing, Math.max(3, Math.ceil(size / (2 * attempt))))
      const still = []
      for (const part of parts) {
        if (opt.signal && opt.signal.aborted) throw new Error('已取消')
        try {
          const got = await runBatch(llm, part, contextFor(part[0]), opt.hint, opt.signal)
          for (const s of part) {
            const item = got.get(s.i)
            if (item && (item.zh || item.skip)) { apply(s, item); done++ } else still.push(s)
          }
        } catch (e) {
          if (opt.signal && opt.signal.aborted) throw e
          errors.push(e.message)
          still.push(...part)
        }
        if (opt.onProgress) opt.onProgress(done, total)
        if (opt.onBatch) await opt.onBatch()
      }
      missing = still
    }
  }), opt.concurrency || 3)

  return { failed: total - done, errors: [...new Set(errors)].slice(0, 5) }
}

function chunk(arr, n) {
  const out = []
  for (let k = 0; k < arr.length; k += n) out.push(arr.slice(k, k + n))
  return out
}

/** 全篇概述 + 关键术语 */
export async function summarizeLesson(llm, sentences, opt = {}) {
  const body = sentences.filter(s => !s.skip).map(s => s.en || s.text).join('\n').slice(0, 60000)
  const text = await llm.complete({
    system: SUMMARY_SYSTEM,
    user: (opt.hint ? `材料：${opt.hint}\n\n` : '') + body,
    maxTokens: 12000,
    signal: opt.signal,
  })
  const j = extractJson(text)
  return {
    titleZh: str(j.title_zh, 80),
    summaryZh: str(j.summary_zh, 2000),
    terms: (Array.isArray(j.terms) ? j.terms : [])
      .filter(t => t && typeof t.w === 'string' && t.w.trim())
      .slice(0, 20)
      .map(t => ({ w: str(t.w, 120), ipa: str(t.ipa, 160), zh: str(t.zh, 200), explain: str(t.explain, 400) })),
  }
}
