// Streams text containing ANSI escape sequences into a container as line <div>s.
// Supports SGR colors (16, 256, truecolor), bold/dim/italic/underline/inverse,
// carriage-return line rewrites, backspace and clear-screen. Other sequences are dropped.

const TOKEN = /\x1b\[([0-9;?]*)([A-Za-z@`])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[^[\]]|\r\n|\n|\r|\x08|\x07|[^\x1b\r\n\x08\x07]+/g
const PARTIAL = /\x1b(?:\[[0-9;?]*|\][^\x07\x1b]*|[()])?$/

function color256(n) {
  if (n < 16) return null
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  n -= 16
  const c = v => (v ? v * 40 + 55 : 0)
  return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`
}

export class AnsiWriter {
  constructor(container, maxLines = 4000) {
    this.c = container
    this.maxLines = maxLines
    this.reset()
  }

  reset() {
    this.st = { fg: null, bg: null, b: false, d: false, i: false, u: false, inv: false }
    this.line = null
    this.span = null
    this.spanKey = null
    this.overwrite = false
    this.carry = ''
  }

  clear() {
    this.c.innerHTML = ''
    this.line = null
    this.span = null
    this.overwrite = false
  }

  write(text) {
    text = this.carry + text
    this.carry = ''
    const p = PARTIAL.exec(text)
    if (p) {
      this.carry = p[0]
      text = text.slice(0, p.index)
    }
    TOKEN.lastIndex = 0
    let m
    while ((m = TOKEN.exec(text))) {
      const t = m[0]
      if (t === '\n' || t === '\r\n') this.newline()
      else if (t === '\r') this.overwrite = true
      else if (t === '\x08') this.backspace()
      else if (t === '\x07') continue
      else if (t[0] !== '\x1b') this.append(t)
      else if (m[2] === 'm') this.sgr(m[1])
      else if (m[2] === 'J' && (m[1] === '2' || m[1] === '3')) this.clear()
    }
    this.trim()
  }

  sgr(params) {
    const ps = params === '' ? [0] : params.split(';').map(Number)
    const st = this.st
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]
      if (p === 0) Object.assign(st, { fg: null, bg: null, b: false, d: false, i: false, u: false, inv: false })
      else if (p === 1) st.b = true
      else if (p === 2) st.d = true
      else if (p === 3) st.i = true
      else if (p === 4) st.u = true
      else if (p === 7) st.inv = true
      else if (p === 22) st.b = st.d = false
      else if (p === 23) st.i = false
      else if (p === 24) st.u = false
      else if (p === 27) st.inv = false
      else if (p >= 30 && p <= 37) st.fg = p - 30
      else if (p >= 90 && p <= 97) st.fg = p - 82
      else if (p === 39) st.fg = null
      else if (p >= 40 && p <= 47) st.bg = p - 40
      else if (p >= 100 && p <= 107) st.bg = p - 92
      else if (p === 49) st.bg = null
      else if (p === 38 || p === 48) {
        let val = null
        if (ps[i + 1] === 5) {
          const n = ps[i + 2]
          val = n < 16 ? n : color256(n)
          i += 2
        } else if (ps[i + 1] === 2) {
          val = `rgb(${ps[i + 2] | 0},${ps[i + 3] | 0},${ps[i + 4] | 0})`
          i += 4
        }
        if (p === 38) st.fg = val
        else st.bg = val
      }
    }
    this.span = null
  }

  ensureLine() {
    if (!this.line) {
      this.line = document.createElement('div')
      this.c.append(this.line)
      this.span = null
    }
  }

  newline() {
    this.ensureLine()
    if (this.overwrite) this.overwrite = false
    this.line = null
    this.span = null
  }

  backspace() {
    const s = this.line?.lastChild
    if (s && s.textContent) s.textContent = s.textContent.slice(0, -1)
  }

  append(text) {
    this.ensureLine()
    if (this.overwrite) {
      this.line.textContent = ''
      this.span = null
      this.overwrite = false
    }
    const st = this.st
    let fg = st.fg
    let bg = st.bg
    if (st.inv) [fg, bg] = [bg ?? 'inv-fg', fg ?? 'inv-bg']
    const key = [fg, bg, st.b, st.d, st.i, st.u].join('|')
    if (this.span && this.spanKey === key) {
      this.span.textContent += text
      return
    }
    if (key === 'null|null|false|false|false|false') {
      this.span = document.createTextNode(text)
      this.spanKey = key
      this.line.append(this.span)
      return
    }
    const span = document.createElement('span')
    const cls = []
    const style = []
    if (typeof fg === 'number') cls.push('a-f' + fg)
    else if (fg === 'inv-fg') cls.push('a-inv-f')
    else if (fg) style.push('color:' + fg)
    if (typeof bg === 'number') cls.push('a-b' + bg)
    else if (bg === 'inv-bg') cls.push('a-inv-b')
    else if (bg) style.push('background:' + bg)
    if (st.b) cls.push('a-bold')
    if (st.d) cls.push('a-dim')
    if (st.i) cls.push('a-it')
    if (st.u) cls.push('a-ul')
    span.className = cls.join(' ')
    if (style.length) span.style.cssText = style.join(';')
    span.textContent = text
    this.line.append(span)
    this.span = span
    this.spanKey = key
  }

  trim() {
    const extra = this.c.childElementCount - this.maxLines
    for (let i = 0; i < extra; i++) this.c.firstChild.remove()
  }
}

export const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z@`]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b./g, '')
