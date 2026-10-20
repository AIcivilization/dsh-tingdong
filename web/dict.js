// web/dict.js — 听写对答案（不依赖浏览器，测试里也能用）

/** 听写对答案：按词对齐（最长公共子序列），返回每个词对没对上和得分 */
const NUM = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve', 15: 'fifteen', 20: 'twenty', 21: 'twenty-one' }
const normTok = w => { const x = w.toLowerCase().replace(/’/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''); return NUM[x] || x }
export function dictationDiff(answer, typed) {
  const a = String(answer).split(/\s+/).filter(Boolean)
  const an = a.map(normTok)
  const b = String(typed).split(/\s+/).map(normTok).filter(Boolean)
  const L = Array.from({ length: an.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let x = an.length - 1; x >= 0; x--) for (let y = b.length - 1; y >= 0; y--) {
    L[x][y] = an[x] === b[y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1])
  }
  const ok = new Array(an.length).fill(false)
  let x = 0
  let y = 0
  while (x < an.length && y < b.length) {
    if (an[x] === b[y]) { ok[x] = true; x++; y++ } else if (L[x + 1][y] >= L[x][y + 1]) x++; else y++
  }
  const hit = ok.filter(Boolean).length
  return { words: a.map((w, k) => ({ w, ok: ok[k] })), score: an.length ? hit / an.length : 0, extra: Math.max(0, b.length - hit) }
}
