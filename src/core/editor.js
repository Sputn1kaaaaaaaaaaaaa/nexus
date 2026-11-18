import { highlight, endState, langInfo, tokenize } from './syntax.js'
import { el, esc } from '../ui/dom.js'

// The editor is a native <textarea> (input, selection, IME, undo history) layered over a
// virtualized highlight view that renders only the visible lines.

const PAD_T = 4
const PAD_L = 8
const OPEN = { '(': ')', '[': ']', '{': '}' }
const CLOSE = { ')': '(', ']': '[', '}': '{' }
const QUOTES = { '"': '"', "'": "'", '`': '`' }
const VOID_TAGS = new Set('area base br col embed hr img input link meta source track wbr'.split(' '))

export const config = {
  fontSize: 13,
  lineHeight: 19,
  tabSize: 4,
  insertSpaces: true,
  detectIndent: true,
  autoClose: true,
  autocomplete: true,
  cw: 7.8,
}

const views = new Set()
const hlCache = new Map()

document.addEventListener('selectionchange', () => {
  const a = document.activeElement
  for (const v of views) {
    if (v.ta === a) {
      v.cursorMoved()
      break
    }
  }
})

function measure() {
  const probe = el('span', 'ed-measure', { text: 'x'.repeat(200) })
  probe.style.fontSize = config.fontSize + 'px'
  document.body.append(probe)
  config.cw = probe.getBoundingClientRect().width / 200 || config.fontSize * 0.6
  probe.remove()
}

export function configure(opts) {
  Object.assign(config, opts)
  config.lineHeight = Math.round(config.fontSize * 1.45)
  document.documentElement.style.setProperty('--ed-fs', config.fontSize + 'px')
  document.documentElement.style.setProperty('--ed-lh', config.lineHeight + 'px')
  measure()
  for (const v of views) v.applyConfig()
}

export function visCol(line, col, tab) {
  let v = 0
  for (let k = 0; k < col && k < line.length; k++) v = line[k] === '\t' ? v + tab - (v % tab) : v + 1
  return v + Math.max(0, col - line.length)
}

function detectIndent(text, fallback) {
  let tabs = 0
  let two = 0
  let four = 0
  let n = 0
  for (const line of text.split('\n', 3000)) {
    if (line[0] === '\t') tabs++
    else if (line[0] === ' ' && line.trim()) {
      const w = /^ +/.exec(line)[0].length
      if (w % 4 === 0) four++
      else if (w % 2 === 0) two++
      n++
    }
  }
  if (tabs > n) return { size: fallback.size, spaces: false }
  if (!n) return fallback
  return { size: two > 0 && two >= n * 0.1 ? 2 : 4, spaces: true }
}

export class EditorView {
  constructor(doc) {
    this.doc = doc
    this.lang = doc.lang
    this.el = el('div', 'ed')
    this.gutter = el('div', 'ed-gutter')
    this.gutterInner = el('div', 'ed-gutter-inner')
    this.gutter.append(this.gutterInner)
    this.main = el('div', 'ed-main')
    this.lineHl = el('div', 'ed-linehl')
    this.marks = el('div', 'ed-marks')
    this.code = el('div', 'ed-code')
    this.ta = el('textarea', 'ed-input', {
      spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off',
      wrap: 'off', 'aria-label': 'Editor ' + doc.path, 'aria-multiline': 'true',
    })
    this.main.append(this.lineHl, this.marks, this.code, this.ta)
    this.el.append(this.gutter, this.main)

    this.text = ''
    this.lines = ['']
    this.starts = [0]
    this.states = ['']
    this.valid = 0
    this.version = 0
    this.findMatches = []
    this.findCurrent = -1
    this.diag = new Map()
    this.bracket = null
    this.raf = 0
    this.programmatic = false
    this.lastSel = [-1, -1]
    this.onChange = null
    this.onCursor = null
    this.indent = { size: config.tabSize, spaces: config.insertSpaces }
    this.ac = new Autocomplete(this)

    this.ta.addEventListener('input', e => this.onInput(e))
    this.ta.addEventListener('scroll', () => this.schedule())
    this.ta.addEventListener('keydown', e => this.onKeyDown(e))
    this.ta.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement !== this.ta) this.ac.close()
    }, 100))
    this.ta.addEventListener('mousedown', () => this.ac.close())
    for (const ev of ['keyup', 'mouseup', 'select', 'focus']) this.ta.addEventListener(ev, () => this.cursorMoved())
    this.gutter.addEventListener('wheel', e => {
      this.ta.scrollTop += e.deltaY
      e.preventDefault()
    }, { passive: false })
    this.gutter.addEventListener('mousedown', e => {
      e.preventDefault()
      const li = Math.floor((e.clientY - this.gutter.getBoundingClientRect().top - PAD_T + this.ta.scrollTop) / config.lineHeight)
      if (li < 0 || li >= this.lines.length) return
      this.focus()
      this.select(this.starts[li], li + 1 < this.lines.length ? this.starts[li + 1] : this.text.length)
    })
    new ResizeObserver(() => this.schedule()).observe(this.main)
    views.add(this)
    this.applyConfig()
  }

  destroy() {
    views.delete(this)
    cancelAnimationFrame(this.raf)
    this.el.remove()
  }

  applyConfig() {
    const fallback = { size: config.tabSize, spaces: config.insertSpaces }
    if (this.lang === 'javascript' || this.lang === 'json' || this.lang === 'html' || this.lang === 'css') fallback.size = 2
    this.indent = this.indentOverride || (config.detectIndent ? detectIndent(this.text, fallback) : fallback)
    this.el.style.setProperty('--tab', this.indent.size)
    this.schedule()
  }

  get unit() {
    return this.indent.spaces ? ' '.repeat(this.indent.size) : '\t'
  }

  setLanguage(lang) {
    this.lang = lang
    this.valid = 0
    this.applyConfig()
  }

  // ---- text model ----

  setValue(text) {
    this.ta.value = text
    this.sync()
    this.applyConfig()
    this.select(0, 0, { reveal: false })
  }

  onInput(e) {
    this.sync()
    if (this.programmatic) return
    if (e.inputType === 'insertText' && e.data && /[\w$.]/.test(e.data) && config.autocomplete) this.ac.trigger(false)
    else if (this.ac.open && /^delete/.test(e.inputType || '')) this.ac.trigger(false)
    else this.ac.close()
  }

  sync() {
    const text = this.ta.value
    if (text === this.text) return
    const lines = text.split('\n')
    const old = this.lines
    const m = Math.min(old.length, lines.length)
    let k = 0
    while (k < m && old[k] === lines[k]) k++
    this.text = text
    this.lines = lines
    this.valid = Math.min(this.valid, k)
    const starts = new Array(lines.length)
    let pos = 0
    for (let i = 0; i < lines.length; i++) {
      starts[i] = pos
      pos += lines[i].length + 1
    }
    this.starts = starts
    this.version++
    this.onChange?.(this)
    this.schedule()
  }

  lineOf(pos) {
    const s = this.starts
    let lo = 0
    let hi = s.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (s[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  lineEnd(i) {
    return this.starts[i] + this.lines[i].length
  }

  posAt(line, col) {
    const li = Math.max(0, Math.min(this.lines.length - 1, line))
    return this.starts[li] + Math.max(0, Math.min(this.lines[li].length, col))
  }

  get sel() {
    return [this.ta.selectionStart, this.ta.selectionEnd]
  }

  cursor() {
    const [s, e] = this.sel
    const head = this.ta.selectionDirection === 'backward' ? s : e
    const li = this.lineOf(head)
    return { line: li + 1, col: head - this.starts[li] + 1, selected: e - s, lines: this.lines.length }
  }

  // ---- editing primitives (routed through execCommand to keep native undo) ----

  focus() {
    if (document.activeElement !== this.ta) this.ta.focus({ preventScroll: true })
  }

  replace(start, end, text, selStart = start + text.length, selEnd = selStart) {
    this.focus()
    this.ta.setSelectionRange(start, end)
    if (start !== end || text) {
      this.programmatic = true
      const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete')
      this.programmatic = false
      if (!ok) {
        this.ta.setRangeText(text, start, end, 'end')
        this.sync()
      }
    }
    this.ta.setSelectionRange(selStart, selEnd)
    this.sync()
    this.cursorMoved()
  }

  replaceAllText(text, keepSel = true) {
    const [s, e] = this.sel
    const top = this.ta.scrollTop
    this.replace(0, this.text.length, text, 0, 0)
    if (keepSel) {
      this.ta.setSelectionRange(Math.min(s, text.length), Math.min(e, text.length))
      this.ta.scrollTop = top
    }
    this.cursorMoved()
  }

  select(start, end = start, { reveal = true, center = false, backward = false } = {}) {
    this.ta.setSelectionRange(Math.min(start, end), Math.max(start, end), backward ? 'backward' : 'forward')
    if (reveal) this.reveal(backward ? Math.min(start, end) : end, center)
    this.cursorMoved()
  }

  setHead(head, extend) {
    const [s, e] = this.sel
    const anchor = this.ta.selectionDirection === 'backward' ? e : s
    if (!extend) return this.select(head, head)
    this.select(Math.min(anchor, head), Math.max(anchor, head), { backward: head < anchor })
  }

  reveal(pos, center = false) {
    const { lineHeight: lh, cw } = config
    const ta = this.ta
    this.pendingScroll = null
    const li = this.lineOf(pos)
    const y = PAD_T + li * lh
    const h = ta.clientHeight
    if (center && (y < ta.scrollTop || y + lh > ta.scrollTop + h)) ta.scrollTop = y - h / 2
    else if (y < ta.scrollTop) ta.scrollTop = y - PAD_T
    else if (y + lh > ta.scrollTop + h) ta.scrollTop = y + lh - h + PAD_T
    const x = PAD_L + visCol(this.lines[li], pos - this.starts[li], this.indent.size) * cw
    if (x < ta.scrollLeft + PAD_L) ta.scrollLeft = Math.max(0, x - 40)
    else if (x > ta.scrollLeft + ta.clientWidth - 24) ta.scrollLeft = x - ta.clientWidth + 60
    this.schedule()
  }

  selectedLines() {
    const [s, e] = this.sel
    const a = this.lineOf(s)
    let b = this.lineOf(e)
    if (b > a && e === this.starts[b]) b--
    return [a, b]
  }

  // ---- rendering ----

  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.render())
  }

  ensureStates(upto) {
    for (let i = this.valid; i < upto && i < this.lines.length; i++) {
      this.states[i + 1] = endState(this.lang, this.lines[i], this.states[i])
    }
    this.valid = Math.max(this.valid, Math.min(upto, this.lines.length - 1))
  }

  lineHtml(i) {
    const text = this.lines[i]
    if (text.length > 3000) return esc(text.slice(0, 3000)) + '<span class="t-cm"> …</span>'
    const key = this.lang + '\u0001' + this.states[i] + '\u0001' + text
    let html = hlCache.get(key)
    if (html === undefined) {
      html = highlight(this.lang, text, this.states[i]).html
      if (hlCache.size > 6000) hlCache.clear()
      hlCache.set(key, html)
    }
    return html
  }

  render() {
    this.raf = 0
    if (!this.el.isConnected || this.el.offsetParent === null) return
    const { lineHeight: lh, cw } = config
    const ta = this.ta
    if (this.pendingScroll) {
      ta.scrollTop = this.pendingScroll.top
      ta.scrollLeft = this.pendingScroll.left
      this.pendingScroll = null
    }
    const top = ta.scrollTop
    const left = ta.scrollLeft
    const first = Math.max(0, Math.floor((top - PAD_T) / lh))
    const last = Math.min(this.lines.length - 1, Math.ceil((top + ta.clientHeight) / lh))
    this.ensureStates(last)

    let html = ''
    for (let i = first; i <= last; i++) html += '<div>' + this.lineHtml(i) + '</div>'
    this.code.innerHTML = html
    const y = PAD_T + first * lh - top
    const tr = `translate(${PAD_L - left}px, ${y}px)`
    this.code.style.transform = tr
    this.marks.style.transform = tr

    const [s, e] = this.sel
    const curLine = this.lineOf(this.ta.selectionDirection === 'backward' ? s : e)
    this.lineHl.style.transform = `translateY(${PAD_T + curLine * lh - top}px)`
    this.lineHl.style.display = s === e ? '' : 'none'

    // marks: find matches + bracket pair
    const tab = this.indent.size
    let marks = ''
    const box = (pos, len, cls) => {
      const li = this.lineOf(pos)
      if (li < first || li > last) return
      const line = this.lines[li]
      const c0 = pos - this.starts[li]
      const x0 = visCol(line, c0, tab) * cw
      const x1 = visCol(line, Math.min(line.length, c0 + len), tab) * cw
      marks += `<i class="${cls}" style="top:${(li - first) * lh}px;left:${x0}px;width:${Math.max(x1 - x0, cw / 2)}px"></i>`
    }
    if (this.findMatches.length) {
      const lo = this.starts[first]
      const hi = last + 1 < this.lines.length ? this.starts[last + 1] : this.text.length + 1
      let a = 0
      let b = this.findMatches.length
      while (a < b) {
        const mid = (a + b) >> 1
        if (this.findMatches[mid][1] < lo) a = mid + 1
        else b = mid
      }
      for (let k = a; k < this.findMatches.length && this.findMatches[k][0] < hi; k++) {
        const [ms, me] = this.findMatches[k]
        box(ms, me - ms, k === this.findCurrent ? 'm-find cur' : 'm-find')
      }
    }
    if (this.bracket) {
      const [p, q] = this.bracket
      box(p, 1, q < 0 ? 'm-bad' : 'm-br')
      if (q >= 0) box(q, 1, 'm-br')
    }
    this.marks.innerHTML = marks

    // gutter
    const digits = Math.max(3, String(this.lines.length).length)
    const gw = Math.ceil(digits * cw + 14)
    if (this.gutterW !== gw) {
      this.gutterW = gw
      this.gutter.style.width = gw + 'px'
    }
    let g = ''
    for (let i = first; i <= last; i++) {
      const d = this.diag.get(i)
      g += `<div class="${i === curLine ? 'cur' : ''}${d ? ' ' + d : ''}">${i + 1}</div>`
    }
    this.gutterInner.innerHTML = g
    this.gutterInner.style.transform = `translateY(${y}px)`

    const selKey = s + ':' + e
    if (selKey !== this.lastSelKey) {
      this.lastSelKey = selKey
      this.onCursor?.(this)
    }
  }

  cursorMoved() {
    this.bracket = this.findBracket()
    this.schedule()
  }

  setFind(matches, current) {
    this.findMatches = matches
    this.findCurrent = current
    this.schedule()
  }

  setDiagnostics(list) {
    this.diag = new Map()
    for (const d of list) {
      if (d.line == null) continue
      const prev = this.diag.get(d.line - 1)
      if (prev !== 'error') this.diag.set(d.line - 1, d.severity === 'error' ? 'error' : 'warning')
    }
    this.schedule()
  }

  findBracket() {
    const [s, e] = this.sel
    if (s !== e || this.text.length > 2e6) return null
    for (const p of [s - 1, s]) {
      const ch = this.text[p]
      if (OPEN[ch]) return [p, this.scanBracket(p, ch, OPEN[ch], 1)]
      if (CLOSE[ch]) return [p, this.scanBracket(p, ch, CLOSE[ch], -1)]
    }
    return null
  }

  scanBracket(p, self, other, dir) {
    let depth = 0
    const t = this.text
    for (let i = p, n = 0; i >= 0 && i < t.length && n < 200000; i += dir, n++) {
      if (t[i] === self) depth++
      else if (t[i] === other && --depth === 0) return i
    }
    return -1
  }

  // ---- key handling ----

  onKeyDown(e) {
    if (this.ac.open && this.ac.handleKey(e)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const mod = e.ctrlKey || e.metaKey
    let handled = false
    if (e.key === 'Tab' && !mod && !e.altKey) {
      handled = true
      if (e.shiftKey) this.indentLines(-1)
      else this.tab()
    } else if (e.key === 'Enter' && !mod && !e.altKey) {
      handled = true
      this.newline()
    } else if (e.key === 'Backspace' && !mod && !e.altKey && !e.shiftKey) {
      handled = this.smartBackspace()
    } else if (e.key === 'Home' && !mod && !e.altKey) {
      handled = true
      this.smartHome(e.shiftKey)
    } else if (e.key === 'Escape' && this.ac.open) {
      handled = true
      this.ac.close()
    } else if (!mod && !e.altKey && e.key.length === 1) {
      handled = this.typeChar(e.key)
    }
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  tab() {
    const [s, e] = this.sel
    if (this.lineOf(s) !== this.lineOf(e)) return this.indentLines(1)
    if (!this.indent.spaces) return this.replace(s, e, '\t')
    const li = this.lineOf(s)
    const v = visCol(this.lines[li], s - this.starts[li], this.indent.size)
    this.replace(s, e, ' '.repeat(this.indent.size - (v % this.indent.size)))
  }

  indentLines(dir) {
    const [s, e] = this.sel
    const [a, b] = this.selectedLines()
    const size = this.indent.size
    let delta0 = 0
    let total = 0
    const out = []
    for (let i = a; i <= b; i++) {
      const line = this.lines[i]
      let next = line
      if (dir > 0) {
        if (line.trim() || a === b) next = this.unit + line
      } else {
        const m = /^(\t| {1,})/.exec(line)
        if (m) next = line.slice(m[1] === '\t' ? 1 : Math.min(size, m[1].length))
      }
      const d = next.length - line.length
      if (i === a) delta0 = d
      total += d
      out.push(next)
    }
    if (!total) return
    const start = this.starts[a]
    this.replace(start, this.lineEnd(b), out.join('\n'))
    const ns = Math.max(start, s + (s > start || dir > 0 ? delta0 : 0))
    this.select(s === e ? ns : ns, s === e ? ns : Math.max(ns, e + total), { reveal: false })
  }

  newline() {
    const [s, e] = this.sel
    const li = this.lineOf(s)
    const line = this.lines[li]
    const col = s - this.starts[li]
    const before = line.slice(0, col)
    const after = this.text.slice(e, this.lineEnd(this.lineOf(e)))
    let ind = /^[ \t]*/.exec(line)[0]
    if (ind.length > col) ind = ind.slice(0, col)
    const L = langInfo(this.lang)
    const trimmed = before.trimEnd()
    const last = trimmed.slice(-1)
    let extra = ''
    let closer = ''
    if (OPEN[last] && this.lang !== 'plaintext' && this.lang !== 'markdown') {
      extra = this.unit
      if (after.trimStart()[0] === OPEN[last]) closer = OPEN[last]
    } else if (L.indentColon && last === ':') extra = this.unit
    else if (this.lang === 'shell' && /\b(then|do|else)$/.test(trimmed)) extra = this.unit
    else if (this.lang === 'html') {
      const m = /<([a-zA-Z][\w-]*)(?:\s[^<>]*)?>$/.exec(trimmed)
      if (m && !VOID_TAGS.has(m[1].toLowerCase()) && !trimmed.endsWith('/>')) {
        extra = this.unit
        if (after.trimStart().toLowerCase().startsWith('</' + m[1].toLowerCase())) closer = '<'
      }
    }
    if (L.indentColon && /^\s*(return|pass|break|continue|raise)\b/.test(before) && ind.length) {
      ind = ind.endsWith('\t') ? ind.slice(0, -1) : ind.slice(0, Math.max(0, ind.length - this.indent.size))
    }
    const start = before.trim() === '' && col > 0 ? this.starts[li] : s
    const wsAfter = /^[ \t]*/.exec(after)[0].length
    if (closer) {
      const text = '\n' + ind + extra + '\n' + ind
      const caret = start + 1 + ind.length + extra.length
      this.replace(start, e + wsAfter, text, caret)
    } else {
      this.replace(start, e + wsAfter, '\n' + ind + extra)
    }
    this.reveal(this.sel[1])
  }

  smartBackspace() {
    const [s, e] = this.sel
    if (s !== e || s === 0) return false
    const prev = this.text[s - 1]
    const next = this.text[s]
    if (config.autoClose && ((OPEN[prev] && OPEN[prev] === next) || (QUOTES[prev] && prev === next))) {
      this.replace(s - 1, s + 1, '')
      return true
    }
    const li = this.lineOf(s)
    const col = s - this.starts[li]
    const before = this.lines[li].slice(0, col)
    if (this.indent.spaces && col > 0 && /^ +$/.test(before)) {
      const n = ((col - 1) % this.indent.size) + 1
      this.replace(s - n, s, '')
      return true
    }
    return false
  }

  smartHome(extend) {
    const [s, e] = this.sel
    const head = this.ta.selectionDirection === 'backward' ? s : e
    const li = this.lineOf(head)
    const ind = /^[ \t]*/.exec(this.lines[li])[0].length
    const col = head - this.starts[li]
    this.setHead(this.starts[li] + (col === ind ? 0 : ind), extend)
  }

  typeChar(ch) {
    if (!config.autoClose || this.lang === 'plaintext') return false
    const [s, e] = this.sel
    const next = this.text[e]
    const prev = this.text[s - 1]
    const pairs = langInfo(this.lang).pairs || '()[]{}""\'\''
    const isQuote = !!QUOTES[ch] && pairs.includes(ch + ch)
    if (s === e && next === ch && (CLOSE[ch] || isQuote)) {
      this.select(s + 1, s + 1, { reveal: false })
      return true
    }
    if (!OPEN[ch] && !isQuote) return false
    if (this.lang === 'markdown' && ch === "'") return false
    const close = OPEN[ch] || ch
    if (s !== e) {
      this.replace(s, e, ch + this.text.slice(s, e) + close, s + 1, e + 1)
      return true
    }
    if (next !== undefined && !/[\s)\]},;:]/.test(next)) return false
    if (isQuote && prev && /[\w\\]/.test(prev)) return false
    this.replace(s, s, ch + close, s + 1)
    return true
  }

  // ---- commands ----

  toggleComment() {
    const L = langInfo(this.lang)
    const [s, e] = this.sel
    const [a, b] = this.selectedLines()
    const lines = this.lines.slice(a, b + 1)
    const nonEmpty = lines.filter(l => l.trim())
    if (!nonEmpty.length) return
    let out
    if (L.line) {
      const tok = L.line
      const all = nonEmpty.every(l => l.trimStart().startsWith(tok))
      const minInd = Math.min(...nonEmpty.map(l => /^[ \t]*/.exec(l)[0].length))
      out = lines.map(l => {
        if (!l.trim()) return l
        if (all) {
          const i = l.indexOf(tok)
          return l.slice(0, i) + l.slice(i + tok.length + (l[i + tok.length] === ' ' ? 1 : 0))
        }
        return l.slice(0, minInd) + tok + ' ' + l.slice(minInd)
      })
    } else if (L.block) {
      const [open, close] = L.block
      const first = lines[0]
      const lastL = lines[lines.length - 1]
      if (first.trimStart().startsWith(open) && lastL.trimEnd().endsWith(close)) {
        out = lines.slice()
        const i = first.indexOf(open)
        out[0] = first.slice(0, i) + first.slice(i + open.length).replace(/^ /, '')
        const lst = out[out.length - 1]
        const j = lst.lastIndexOf(close)
        out[out.length - 1] = lst.slice(0, j).replace(/ $/, '') + lst.slice(j + close.length)
      } else {
        out = lines.slice()
        const ind = /^[ \t]*/.exec(first)[0].length
        out[0] = first.slice(0, ind) + open + ' ' + first.slice(ind)
        out[out.length - 1] = out[out.length - 1] + ' ' + close
      }
    } else return
    const text = out.join('\n')
    const start = this.starts[a]
    this.replace(start, this.lineEnd(b), text)
    if (s === e) {
      const d = out[0].length - lines[0].length
      const p = Math.max(start, s + d)
      this.select(p, p, { reveal: false })
    } else this.select(start, start + text.length, { reveal: false })
  }

  moveLines(dir) {
    const [s, e] = this.sel
    const [a, b] = this.selectedLines()
    if ((dir < 0 && a === 0) || (dir > 0 && b >= this.lines.length - 1)) return
    const block = this.lines.slice(a, b + 1).join('\n')
    if (dir < 0) {
      const other = this.lines[a - 1]
      const start = this.starts[a - 1]
      this.replace(start, this.lineEnd(b), block + '\n' + other)
      const d = other.length + 1
      this.select(s - d, e - d)
    } else {
      const other = this.lines[b + 1]
      const start = this.starts[a]
      this.replace(start, this.lineEnd(b + 1), other + '\n' + block)
      const d = other.length + 1
      this.select(s + d, e + d)
    }
  }

  copyLines(dir) {
    const [s, e] = this.sel
    const [a, b] = this.selectedLines()
    const block = this.lines.slice(a, b + 1).join('\n')
    if (dir > 0) {
      this.replace(this.lineEnd(b), this.lineEnd(b), '\n' + block)
      const d = block.length + 1
      this.select(s + d, e + d)
    } else {
      this.replace(this.starts[a], this.starts[a], block + '\n')
      this.select(s, e)
    }
  }

  deleteLines() {
    const [a, b] = this.selectedLines()
    const col = this.sel[0] - this.starts[a]
    let start = this.starts[a]
    let end = b + 1 < this.lines.length ? this.starts[b + 1] : this.lineEnd(b)
    if (b + 1 >= this.lines.length && a > 0) start = this.lineEnd(a - 1)
    this.replace(start, end, '')
    const li = Math.min(a, this.lines.length - 1)
    const p = this.posAt(li, col)
    this.select(p, p)
  }

  insertLine(below) {
    const [s] = this.sel
    const li = this.lineOf(s)
    const ind = /^[ \t]*/.exec(this.lines[li])[0]
    if (below) {
      const p = this.lineEnd(li)
      this.replace(p, p, '\n' + ind)
    } else {
      const p = this.starts[li]
      this.replace(p, p, ind + '\n', p + ind.length)
    }
  }

  selectLine() {
    const [s, e] = this.sel
    const [a, b] = this.selectedLines()
    const fullStart = this.starts[a]
    const fullEnd = b + 1 < this.lines.length ? this.starts[b + 1] : this.text.length
    if (s === fullStart && e === fullEnd && e < this.text.length) {
      const nb = this.lineOf(e)
      this.select(s, nb + 1 < this.lines.length ? this.starts[nb + 1] : this.text.length)
    } else this.select(fullStart, fullEnd)
  }

  wordAt(pos) {
    const li = this.lineOf(pos)
    const line = this.lines[li]
    const col = pos - this.starts[li]
    let a = col
    let b = col
    while (a > 0 && /[\w$]/.test(line[a - 1])) a--
    while (b < line.length && /[\w$]/.test(line[b])) b++
    return a === b ? null : [this.starts[li] + a, this.starts[li] + b]
  }

  selectNextOccurrence() {
    const [s, e] = this.sel
    if (s === e) {
      const w = this.wordAt(s)
      if (w) this.select(w[0], w[1])
      return
    }
    const needle = this.text.slice(s, e)
    let i = this.text.indexOf(needle, e)
    if (i < 0) i = this.text.indexOf(needle)
    if (i >= 0) this.select(i, i + needle.length, { center: true })
  }

  jumpToBracket() {
    const b = this.findBracket()
    if (!b || b[1] < 0) return
    const [s] = this.sel
    const target = b[0] === s - 1 ? b[1] : b[1] + 1
    this.select(target, target)
  }

  gotoLine(line, col = 1) {
    const p = this.posAt(line - 1, col - 1)
    this.select(p, p, { center: true })
    this.focus()
  }

  getViewState() {
    const sc = this.pendingScroll || { top: this.ta.scrollTop, left: this.ta.scrollLeft }
    return { sel: this.sel, top: sc.top, left: sc.left }
  }

  setViewState(st) {
    if (!st) return
    const n = this.text.length
    if (st.sel) this.ta.setSelectionRange(Math.min(st.sel[0], n), Math.min(st.sel[1], n))
    this.pendingScroll = { top: st.top || 0, left: st.left || 0 }
    this.cursorMoved()
  }

  // Hidden (display:none) elements lose their scroll offsets, so keep them across tab switches.
  hide() {
    if (this.el.style.display === 'none') return
    if (!this.pendingScroll) this.pendingScroll = { top: this.ta.scrollTop, left: this.ta.scrollLeft }
    this.el.style.display = 'none'
    this.ac.close()
  }

  show() {
    this.el.style.display = ''
    this.schedule()
  }

  diagnostics() {
    const out = []
    if (this.lang === 'json') {
      if (!this.text.trim()) return out
      try {
        JSON.parse(this.text)
      } catch (err) {
        const msg = String(err.message)
        let line = 1
        let col = 1
        const lc = /line (\d+) column (\d+)/.exec(msg)
        const pos = /position (\d+)/.exec(msg)
        if (lc) {
          line = +lc[1]
          col = +lc[2]
        } else if (pos) {
          const li = this.lineOf(+pos[1])
          line = li + 1
          col = +pos[1] - this.starts[li] + 1
        }
        out.push({ line, col, severity: 'error', message: msg.replace(/^JSON\.parse: /, '') })
      }
      return out
    }
    if (!['c', 'cpp', 'javascript', 'css', 'python', 'html'].includes(this.lang) || this.text.length > 1e6) return out
    const stack = []
    let state = ''
    for (let i = 0; i < this.lines.length && out.length < 20; i++) {
      let col = 0
      state = tokenize(this.lang, this.lines[i], state, (type, s) => {
        if (type === 'br') {
          if (OPEN[s]) stack.push({ ch: s, line: i + 1, col: col + 1 })
          else if (CLOSE[s]) {
            const top = stack[stack.length - 1]
            if (top && top.ch === CLOSE[s]) stack.pop()
            else if (!top) out.push({ line: i + 1, col: col + 1, severity: 'error', message: `Unmatched '${s}'` })
            else {
              out.push({ line: i + 1, col: col + 1, severity: 'error', message: `'${s}' does not match '${top.ch}' at line ${top.line}` })
              stack.pop()
            }
          }
        }
        col += s.length
      })
    }
    for (const u of stack.slice(-5)) out.push({ line: u.line, col: u.col, severity: 'warning', message: `Unclosed '${u.ch}'` })
    return out
  }
}

// ---- autocomplete ----

class Autocomplete {
  constructor(view) {
    this.view = view
    this.el = el('div', 'ac', { role: 'listbox' })
    this.el.addEventListener('mousedown', e => e.preventDefault())
    this.items = []
    this.sel = 0
    this.open = false
    this.wordsVersion = -1
    this.words = []
    view.main.append(this.el)
  }

  collect() {
    const v = this.view
    if (this.wordsVersion === v.version) return
    this.wordsVersion = v.version
    const counts = new Map()
    const re = /[A-Za-z_$][\w$]{2,}/g
    let m
    const text = v.text.length > 2e6 ? v.text.slice(0, 2e6) : v.text
    while ((m = re.exec(text)) && counts.size < 20000) counts.set(m[0], (counts.get(m[0]) || 0) + 1)
    this.counts = counts
  }

  trigger(force) {
    const v = this.view
    const [s, e] = v.sel
    if (s !== e) return this.close()
    const li = v.lineOf(s)
    const line = v.lines[li]
    const col = s - v.starts[li]
    const prefix = /[\w$]*$/.exec(line.slice(0, col))[0]
    if ((!force && prefix.length < 2) || /^\d/.test(prefix)) return this.close()
    if (!force) {
      let last = ''
      tokenize(v.lang, line.slice(0, col), v.states[li] ?? '', t => (last = t))
      if (last === 'cm' || last === 'str') return this.close()
    }
    this.collect()
    const L = langInfo(v.lang)
    const pool = new Map()
    for (const set of [L.kw, L.types, L.consts, L.fns]) for (const w of set || []) pool.set(w, 'k')
    for (const [w, n] of this.counts) {
      if (w === prefix && n <= 1) continue
      if (!pool.has(w)) pool.set(w, 'w')
    }
    const lower = prefix.toLowerCase()
    const scored = []
    for (const [w, kind] of pool) {
      if (w === prefix) continue
      const wl = w.toLowerCase()
      let score
      if (w.startsWith(prefix)) score = 3
      else if (wl.startsWith(lower)) score = 2
      else if (lower.length >= 2 && wl.includes(lower)) score = 1
      else continue
      scored.push({ w, kind, score })
    }
    scored.sort((a, b) => b.score - a.score || a.w.length - b.w.length || a.w.localeCompare(b.w))
    this.items = scored.slice(0, 40)
    this.start = s - prefix.length
    if (!this.items.length) return this.close()
    this.sel = 0
    this.open = true
    this.render(li, col - prefix.length)
  }

  render(li, col) {
    const v = this.view
    this.el.innerHTML = this.items
      .map((it, i) => `<div class="ac-item${i === this.sel ? ' sel' : ''}" data-i="${i}"><span class="ac-kind ${it.kind}">${it.kind === 'k' ? 'kw' : 'ab'}</span>${esc(it.w)}</div>`)
      .join('')
    for (const row of this.el.children) {
      row.addEventListener('click', () => {
        this.sel = +row.dataset.i
        this.accept()
      })
    }
    this.el.style.display = 'block'
    if (li !== undefined) {
      const { lineHeight: lh, cw } = config
      const x = PAD_L + visCol(v.lines[li], col, v.indent.size) * cw - v.ta.scrollLeft
      let y = PAD_T + (li + 1) * lh - v.ta.scrollTop
      const h = this.el.offsetHeight
      if (y + h > v.main.clientHeight && y - lh - h > 0) y = y - lh - h
      this.el.style.left = Math.max(0, Math.min(x, v.main.clientWidth - this.el.offsetWidth - 2)) + 'px'
      this.el.style.top = y + 'px'
    }
    this.el.children[this.sel]?.scrollIntoView({ block: 'nearest' })
  }

  handleKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return false
    const n = this.items.length
    switch (e.key) {
      case 'ArrowDown': this.sel = (this.sel + 1) % n; break
      case 'ArrowUp': this.sel = (this.sel - 1 + n) % n; break
      case 'PageDown': this.sel = Math.min(n - 1, this.sel + 8); break
      case 'PageUp': this.sel = Math.max(0, this.sel - 8); break
      case 'Enter':
      case 'Tab':
        this.accept()
        return true
      case 'Escape':
        this.close()
        return true
      default:
        return false
    }
    this.render()
    return true
  }

  accept() {
    const it = this.items[this.sel]
    const v = this.view
    const [s] = v.sel
    this.close()
    if (it) v.replace(this.start, s, it.w)
  }

  close() {
    if (!this.open) return
    this.open = false
    this.el.style.display = 'none'
  }
}
