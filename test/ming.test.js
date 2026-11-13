import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MING_VOICES, mingUnsupported, mingVoice } from '../lib/ming.js'
import { readInteger, spokenNumbers } from '../lib/spoken.js'

test('本机 Ming 只在 Apple 芯片、macOS 14 以上可用', () => {
  assert.equal(mingUnsupported('darwin', 'arm64', '23.1.0'), undefined)
  assert.match(mingUnsupported('darwin', 'x64', '23.1.0'), /Apple 芯片/)
  assert.match(mingUnsupported('linux', 'arm64', '6.1'), /Apple 芯片/)
  assert.match(mingUnsupported('darwin', 'arm64', '22.6.0'), /macOS 14/)
})

test('Ming 声音：男女都有，名字不重复，找不到就用第一个', () => {
  assert.ok(MING_VOICES.some(v => v.gender === 'f') && MING_VOICES.some(v => v.gender === 'm'))
  assert.equal(new Set(MING_VOICES.map(v => v.id)).size, MING_VOICES.length)
  assert.equal(mingVoice('灵楷').id, '灵楷')
  assert.equal(mingVoice('不存在').id, MING_VOICES[0].id)
})

test('数字先写成汉字给 Ming 念', () => {
  assert.equal(readInteger('1205'), '一千二百零五')
  assert.equal(readInteger('12'), '十二')
  assert.equal(readInteger('20000'), '两万')
  assert.equal(spokenNumbers('还有2个小时，现在是3点15分，涨了30%'), '还有两个小时，现在是三点十五分，涨了百分之三十')
  assert.equal(spokenNumbers('15:30开会'), '十五点三十分开会')
  assert.equal(spokenNumbers('2026年'), '二零二六年')
  assert.equal(spokenNumbers('2026-10-31'), '二零二六年十月三十一日')
  assert.equal(spokenNumbers('20~25℃'), '二十到二十五度')
  assert.equal(spokenNumbers('1.5倍'), '一点五倍')
  assert.equal(spokenNumbers('验证码 0427'), '验证码 零四二七')
  assert.equal(spokenNumbers('从10数到12'), '从十数到十二')
})
