import { el, debounce } from '../ui/dom.js'

const MAX_MATCHES = 20000

function buildRegex(query, { regex, caseSensitive, word }, global = true) {
  let src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (word) src = '\\b(?:' + src + ')\\b'
  return new RegExp(src, (global ? 'g' : '') + 'm' + (caseSensitive ? '' : 'i'))
}

// Find/replace bar for the active editor. Matches are highlighted by the editor view.
export class FindWidget {
  constructor(container, getView) {
    this.getView = getView
    this.opts = { regex: false, caseSensitive: false, word: false }
    this.matches = []
    this.cur = -1
    this.visible = false

    this.el = el('div', 'find', { role: 'search' })
    this.toggleBtn = el('button', 'find-expand', { type: 'button', title: 'Toggle Replace (Ctrl+H)', text: '›' })
    this.q = el('input', 'find-q', { type: 'text', placeholder: 'Find', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Find' })
    this.r = el('input', 'find-r', { type: 'text', placeholder: 'Replace', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Replace' })
    this.count = el('span', 'find-count', { text: 'No results' })
    const opt = (key, label, title) => {
      const b = el('button', 'find-opt', { type: 'button', text: label, title, 'aria-pressed': 'false' })
      b.addEventListener('click', () => this.toggleOpt(key))
      b.dataset.key = key
      return b
    }
    this.optBtns = [opt('caseSensitive', 'Aa', 'Match Case (Alt+C)'), opt('word', 'ab', 'Whole Word (Alt+W)'), opt('regex', '.*', 'Regex (Alt+R)')]
    const btn = (text, title, fn) => el('button', 'find-btn', { type: 'button', text, title, onclick: fn })
    const row1 = el('div', 'find-row')
    row1.append(this.q, ...this.optBtns, this.count,
      btn('↑', 'Previous (Shift+Enter)', () => this.next(-1)),
      btn('↓', 'Next (Enter)', () => this.next(1)),
      btn('×', 'Close (Escape)', () => this.close()))
    this.row2 = el('div', 'find-row find-replace')
    this.row2.append(this.r,
      btn('Replace', 'Replace (Enter)', () => this.replaceOne()),
      btn('All', 'Replace All (Ctrl+Alt+Enter)', () => this.replaceAll()))
    const rows = el('div', 'find-rows')
    rows.append(row1, this.row2)
    this.el.append(this.toggleBtn, rows)
    container.append(this.el)

    this.toggleBtn.addEventListener('click', () => this.showReplace(!this.replaceVisible))
    this.recompute = debounce(() => this.compute(), 120)
    this.q.addEventListener('input', () => this.compute(true))
    for (const input of [this.q, this.r]) input.addEventListener('keydown', e => this.onKey(e, input))
    this.showReplace(false)
  }

  onKey(e, input) {
    const k = e.key
    if (k === 'Escape') this.close()
    else if (e.altKey && /^[cwr]$/i.test(k)) this.toggleOpt({ c: 'caseSensitive', w: 'word', r: 'regex' }[k.toLowerCase()])
    else if (k === 'Enter' && input === this.r && (e.ctrlKey || e.metaKey)) this.replaceAll()
    else if (k === 'Enter' && input === this.r) this.replaceOne()
    else if (k === 'Enter') this.next(e.shiftKey ? -1 : 1)
    else if (k === 'F3') this.next(e.shiftKey ? -1 : 1)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  toggleOpt(key) {
    this.opts[key] = !this.opts[key]
    for (const b of this.optBtns) b.setAttribute('aria-pressed', String(!!this.opts[b.dataset.key]))
    this.compute(true)
  }

  showReplace(on) {
    this.replaceVisible = on
    this.row2.style.display = on ? '' : 'none'
    this.toggleBtn.textContent = on ? '⌄' : '›'
  }

  open(replace = false) {
    const v = this.getView()
    if (!v) return
    this.visible = true
    this.el.classList.add('open')
    this.showReplace(replace || (this.visible && this.replaceVisible && replace !== false))
    const [s, e] = v.sel
    const selected = v.text.slice(s, e)
    if (selected && !selected.includes('\n') && selected.length < 200) {
      this.q.value = this.opts.regex ? selected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : selected
    }
    const target = replace && this.q.value ? this.r : this.q
    target.focus()
    target.select()
    this.compute(true)
  }

  close() {
    if (!this.visible) return
    this.visible = false
    this.el.classList.remove('open')
    const v = this.getView()
    if (v) {
      v.setFind([], -1)
      v.focus()
    }
  }

  compute(jump = false) {
    const v = this.getView()
    if (!v || !this.visible) return
    const query = this.q.value
    this.matches = []
    this.cur = -1
    this.q.classList.remove('invalid')
    if (query) {
      let re
      try {
        re = buildRegex(query, this.opts)
      } catch {
        this.q.classList.add('invalid')
      }
      if (re) {
        let m
        while ((m = re.exec(v.text)) && this.matches.length < MAX_MATCHES) {
          if (!m[0].length) {
            re.lastIndex++
            continue
          }
          this.matches.push([m.index, m.index + m[0].length])
        }
      }
    }
    if (this.matches.length) {
      const from = v.sel[0]
      this.cur = this.matches.findIndex(m => m[0] >= from)
      if (this.cur < 0) this.cur = 0
      if (jump) v.select(this.matches[this.cur][0], this.matches[this.cur][1], { center: true })
    }
    v.setFind(this.matches, this.cur)
    this.updateCount()
  }

  updateCount() {
    const n = this.matches.length
    this.count.textContent = n ? `${this.cur + 1}/${n}${n >= MAX_MATCHES ? '+' : ''}` : this.q.value ? 'No results' : ''
    this.count.classList.toggle('none', !n && !!this.q.value)
  }

  next(dir) {
    const v = this.getView()
    if (!v) return
    if (!this.visible) {
      if (!this.q.value) return this.open()
      this.visible = true
      this.el.classList.add('open')
      this.compute()
    }
    if (!this.matches.length) return
    const [s, e] = v.sel
    if (dir > 0) {
      const i = this.matches.findIndex(m => m[0] >= e || (m[0] >= s && m[0] !== s))
      this.cur = i < 0 ? 0 : i
    } else {
      let i = -1
      for (let k = this.matches.length - 1; k >= 0; k--) {
        if (this.matches[k][0] < s) {
          i = k
          break
        }
      }
      this.cur = i < 0 ? this.matches.length - 1 : i
    }
    const [ms, me] = this.matches[this.cur]
    v.select(ms, me, { center: true })
    v.setFind(this.matches, this.cur)
    this.updateCount()
  }

  replacement(matchText) {
    if (!this.opts.regex) return this.r.value
    return matchText.replace(buildRegex(this.q.value, this.opts, false), this.r.value)
  }

  replaceOne() {
    const v = this.getView()
    if (!v || !this.matches.length) return
    const [s, e] = v.sel
    let m = this.matches.find(x => x[0] === s && x[1] === e)
    if (!m) return this.next(1)
    const repl = this.replacement(v.text.slice(m[0], m[1]))
    v.replace(m[0], m[1], repl)
    this.compute()
    const after = m[0] + repl.length
    const nextIdx = this.matches.findIndex(x => x[0] >= after)
    if (this.matches.length) {
      this.cur = nextIdx < 0 ? 0 : nextIdx
      v.select(this.matches[this.cur][0], this.matches[this.cur][1], { center: true })
      v.setFind(this.matches, this.cur)
      this.updateCount()
    }
    this.r.focus()
  }

  replaceAll() {
    const v = this.getView()
    if (!v || !this.matches.length) return
    let out = ''
    let last = 0
    for (const [s, e] of this.matches) {
      out += v.text.slice(last, s) + this.replacement(v.text.slice(s, e))
      last = e
    }
    out += v.text.slice(last)
    const n = this.matches.length
    v.replaceAllText(out)
    this.compute()
    this.count.textContent = `Replaced ${n}`
    this.r.focus()
  }

  // Called when the active editor or its text changes.
  refresh() {
    if (this.visible) this.recompute()
  }
}
