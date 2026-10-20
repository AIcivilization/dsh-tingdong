// lib/cli-llm.js — 命令行版用哪个模型
//
// 顺序：命令行参数 > 环境变量（TINGDONG_BASE_URL / TINGDONG_API_KEY / TINGDONG_MODEL）
//       > 本机的 dsh-model 网关（~/.dsh-model，同一生态的插件，地址和密钥都在本机）。
// 没指定模型时，在接口的模型列表里优先挑 deepseek。

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openaiLlm } from './llm.js'

async function dshModelGateway() {
  const root = join(homedir(), '.dsh-model')
  try {
    const cfg = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    const yaml = await readFile(join(root, 'engine.yaml'), 'utf8')
    const key = /api-keys:\s*\n\s*-\s*["']?([^"'\n]+)/.exec(yaml)
    const port = Number(cfg.port) || 8317
    return { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: key ? key[1].trim() : '' }
  } catch {
    return null
  }
}

async function pickModel(baseURL, apiKey) {
  try {
    const r = await fetch(baseURL.replace(/\/+$/, '') + '/models', {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(6000),
    })
    const ids = ((await r.json()).data || []).map(m => m.id).filter(id => typeof id === 'string')
    return ids.find(id => /deepseek/i.test(id) && !/embed|bge/i.test(id)) || ids.find(id => !/embed|bge/i.test(id)) || ''
  } catch {
    return ''
  }
}

/** @returns {Promise<object|null>} complete() 接口；没有可用模型返回 null */
export async function cliLlm(flags = {}) {
  let baseURL = flags['base-url'] || process.env.TINGDONG_BASE_URL || ''
  let apiKey = flags['api-key'] || process.env.TINGDONG_API_KEY || ''
  let model = flags.model || process.env.TINGDONG_MODEL || ''
  let via = 'env'
  if (!baseURL) {
    const gw = await dshModelGateway()
    if (gw) { baseURL = gw.baseURL; apiKey = apiKey || gw.apiKey; via = 'dsh-model' }
  }
  if (!baseURL) return null
  if (!model) model = await pickModel(baseURL, apiKey)
  if (!model) return null
  const llm = openaiLlm({ baseURL, apiKey, model })
  llm.via = via
  return llm
}
