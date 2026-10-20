// lib/llm.js — 调大模型的两种方式，对外都是 complete({system, user, maxTokens, signal}) → 文本
//
// 1. dshLlm：插件里用 DSH 自己的 ctx.llm（用户在 DSH 里配好的模型，不用另填密钥）。
//    写法照 dsh-memex：一条 user 消息，拼 text-delta，finish 不是 stop 就算失败。
// 2. openaiLlm：命令行里用任意 OpenAI 兼容接口（/v1/chat/completions）。

import { randomUUID } from 'node:crypto'

/**
 * @param {{stream(o:object):AsyncIterable<any>}} llm DSH 的 ctx.llm
 * @param {() => {provider:string, model:string}|null} route 每次调用时取当前模型
 */
export function dshLlm(llm, route) {
  return {
    label() { const r = route(); return r ? `${r.provider}/${r.model}` : '（未选模型）' },
    async complete({ system, user, maxTokens = 16000, signal }) {
      const r = route()
      if (!r || !r.provider || !r.model) throw new Error('找不到可用的模型：请在 DSH 里选一个默认模型，或在插件配置里填 provider 和 model')
      const message = {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-tingdong' },
        content: [{ type: 'text', text: user }],
      }
      let text = ''
      for await (const chunk of llm.stream({
        provider: r.provider, model: r.model, system, messages: [message], maxTokens,
        ...(signal ? { signal } : {}),
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind !== 'stop') {
          const why = chunk.reason.failure && chunk.reason.failure.message
          throw new Error(`模型没有正常结束（${chunk.reason.kind}${why ? '：' + why : ''}）`)
        }
      }
      return text
    },
  }
}

/** @param {{baseURL:string, apiKey?:string, model:string}} cfg */
export function openaiLlm(cfg) {
  const base = String(cfg.baseURL || '').replace(/\/+$/, '')
  return {
    label() { return cfg.model },
    async complete({ system, user, maxTokens = 16000, signal }) {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          temperature: 0.2,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      })
      const body = await res.text()
      if (!res.ok) throw new Error(`模型接口 HTTP ${res.status}：${body.slice(0, 300)}`)
      const j = JSON.parse(body)
      const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
      if (typeof text !== 'string') throw new Error('模型接口没有返回文字')
      return text
    },
  }
}
