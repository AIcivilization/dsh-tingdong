// lib/spoken.js — 数字和几个符号先写成汉字，给本机 Ming 念（它的 MLX 版没有文字规范化，「2个」会念成「二个」）
// 和 dsh-her 的 core/spoken-numbers.ts 一样：个数、时间、日期、年份、百分比、小数、长串号码、范围、度数。

const DIGITS = '零一二三四五六七八九'
const SMALL_UNITS = ['', '十', '百', '千']
const BIG_UNITS = ['', '万', '亿']

/** 量词前面的 2 念「两」（两个、两点、两次……） */
const MEASURE = /^(?:个|位|点|次|天|只|本|件|张|条|岁|种|遍|杯|分钟|小时|周|斤|块|台|辆|家|句|下|口|双|对|份|层|片|场|首|部|回|趟|步|顿|碗|瓶|盒|袋|根|颗|粒|间|座|所|名|人|样|批|年|星期|礼拜|倍)/
/** 前面是这些词的数字一位一位念 */
const DIGIT_CONTEXT = /(?:验证码|号码|电话|手机|编号|尾号|房间|门牌|邮编|工号|学号|密码|单号)[是为:：\s]*$/

/** "2026" → 二零二六 */
export const readDigits = digits => [...digits].map(d => DIGITS[Number(d)]).join('')

/** "1205" → 一千二百零五；"12" → 十二；"20000" → 两万。超过 12 位一位一位念 */
export function readInteger(number) {
  const digits = number.replace(/^0+(?=\d)/, '')
  if (digits.length > 12) return readDigits(digits)
  if (/^0+$/.test(digits)) return '零'
  const groups = []
  for (let end = digits.length; end > 0; end -= 4) groups.unshift(Number(digits.slice(Math.max(0, end - 4), end)))
  let out = ''
  let zero = false
  groups.forEach((group, i) => {
    const big = BIG_UNITS[groups.length - 1 - i]
    if (group === 0) { zero = out !== ''; return }
    if (out !== '' && (zero || group < 1000)) out += '零'
    zero = false
    out += readGroup(group) + big
  })
  return out.replace(/^一十/, '十').replace(/^二(?=[百千万亿])/, '两')
}

function readGroup(group) {
  let out = ''
  let zero = false
  for (let pos = 3; pos >= 0; pos--) {
    const d = Math.floor(group / 10 ** pos) % 10
    if (d === 0) { zero = out !== ''; continue }
    if (zero) out += '零'
    zero = false
    out += DIGITS[d] + SMALL_UNITS[pos]
  }
  return out
}

const readNumber = n => {
  const [i, f] = n.split('.')
  return f === undefined ? readInteger(i) : `${readInteger(i)}点${readDigits(f)}`
}
const hour = h => (Number(h) === 2 ? '两' : readInteger(h))

export function spokenNumbers(text) {
  return String(text)
    // 30% → 百分之三十
    .replace(/(\d+(?:\.\d+)?)\s*[%％]/g, (_w, n) => `百分之${readNumber(n)}`)
    // 15:30 → 十五点三十分；9:05 → 九点零五分；8:00 → 八点
    .replace(/(\d{1,2})[:：](\d{2})(?!\d)/g, (_w, h, m) => `${hour(h)}点${m === '00' ? '' : `${m.startsWith('0') ? '零' : ''}${readInteger(m)}分`}`)
    // 2026-10-31 → 二零二六年十月三十一日
    .replace(/(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/g, (_w, y, m, d) => `${readDigits(y)}年${readInteger(m)}月${readInteger(d)}日`)
    // 2026年 → 二零二六年
    .replace(/(\d{4})(?=\s*年)/g, (_w, y) => readDigits(y))
    // 20~25度、3-5个 → 到
    .replace(/(?<![\d-])(\d{1,3})\s*[~～—–-]\s*(\d{1,3})(?![\d-])/g, '$1到$2')
    .replace(/\s*(?:℃|°C|°)/g, '度')
    .replace(/(\d+)\.(\d+)/g, (_w, i, f) => `${readInteger(i)}点${readDigits(f)}`)
    .replace(/\d+/g, (n, offset, whole) => {
      const before = whole.slice(0, offset)
      const after = whole.slice(offset + n.length)
      if (n.length >= 7 || (n.length > 1 && n.startsWith('0')) || DIGIT_CONTEXT.test(before)) return readDigits(n)
      if (n === '2' && MEASURE.test(after)) return '两'
      return readInteger(n)
    })
}
