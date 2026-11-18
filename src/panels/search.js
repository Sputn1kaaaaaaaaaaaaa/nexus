import { get } from '../core/api.js'
import { el, esc } from '../ui/dom.js'

// Project-wide search (runs on the server). Enter searches; Down moves into results;
// Enter on a result opens it at the match.
export class SearchView {
  constructor({ onOpen }) {
    this.onOpen = onOpen
    this.opts = { case: false, word: false, regex: false }
    this.flat = []
    this.sel = -1
    this.seq = 0

    this.el = el('div', 'search-view')
    const form = el('div', 'sv-form')
    this.q = el('input', 'sv-q', { type: 'text', placeholder: 'Search project (Enter)', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Search project' })
    this.include = el('input', 'sv-inc', { type: 'text', placeholder: 'Files to include, e.g. *.c, src/**', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Files to include' })
    const row = el('div', 'sv-row')
    row.append(this.q)
    for (const [key, label, title] of [['case', 'Aa', 'Match Case (Alt+C)'], ['word', 'ab', 'Whole Word (Alt+W)'], ['regex', '.*', 'Regex (Alt+R)']]) {
      const b = el('button', 'find-opt', { type: 'button', text: label, title, 'aria-pressed': 'false' })
      b.dataset.key = key
      b.addEventListener('click', () => this.toggle(key))
      row.append(b)
    }
    this.status = el('div', 'sv-status')
    form.append(row, this.include, this.status)
    this.results = el('div', 'sv-results', { tabindex: '0', role: 'tree', 'aria-label': 'Search results' })
    this.el.append(form, this.results)
    this.tools = el('div', 'tools')

    for (const input of [this.q, this.include]) {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') this.run()
        else if (e.key === 'ArrowDown' && this.flat.length) {
          this.results.focus()
          this.move(this.sel < 0 ? 1 : 0)
        } else if (e.altKey && /^[cwr]$/i.test(e.key)) this.toggle({ c: 'case', w: 'word', r: 'regex' }[e.key.toLowerCase()])
        else return
        e.preventDefault()
        e.stopPropagation()
      })
    }
    this.results.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') this.move(1)
      else if (e.key === 'ArrowUp') {
        if (this.sel <= 0) this.q.focus()
        else this.move(-1)
      } else if (e.key === 'Enter') this.open(this.flat[this.sel], true)
      else if (e.key === ' ') this.open(this.flat[this.sel], false)
      else return
      e.preventDefault()
      e.stopPropagation()
    })
  }

  toggle(key) {
    this.opts[key] = !this.opts[key]
    for (const b of this.el.querySelectorAll('.find-opt')) b.setAttribute('aria-pressed', String(this.opts[b.dataset.key]))
    if (this.q.value) this.run()
  }

  async run() {
    const q = this.q.value
    const my = ++this.seq
    if (!q) {
      this.results.innerHTML = ''
      this.status.textContent = ''
      this.flat = []
      return
    }
    this.status.textContent = 'Searching…'
    let res
    try {
      res = await get('/api/search', {
        q, include: this.include.value,
        case: this.opts.case ? '1' : '0', word: this.opts.word ? '1' : '0', regex: this.opts.regex ? '1' : '0',
      })
    } catch (e) {
      if (my === this.seq) this.status.textContent = e.message
      return
    }
    if (my !== this.seq) return
    this.flat = []
    this.sel = -1
    let html = ''
    let total = 0
    for (const file of res.results) {
      html += `<div class="sv-file">${esc(file.path)}<span class="count">${file.matches.length}</span></div>`
      for (const m of file.matches) {
        const i = this.flat.length
        this.flat.push({ path: file.path, ...m })
        const pre = m.text.slice(0, m.at).trimStart()
        const hit = m.text.slice(m.at, m.at + m.len)
        const post = m.text.slice(m.at + m.len)
        html += `<div class="sv-match" data-i="${i}" role="treeitem"><span class="ln">${m.line}</span>` +
          `${esc(pre.length > 40 ? '…' + pre.slice(-40) : pre)}<mark>${esc(hit)}</mark>${esc(post)}</div>`
        total++
      }
    }
    this.results.innerHTML = html
    for (const row of this.results.querySelectorAll('.sv-match')) {
      row.addEventListener('click', () => {
        this.sel = +row.dataset.i
        this.move(0)
        this.open(this.flat[this.sel], true)
      })
    }
    this.status.textContent = total
      ? `${total} result${total > 1 ? 's' : ''} in ${res.results.length} file${res.results.length > 1 ? 's' : ''}${res.truncated ? ' (truncated)' : ''}`
      : 'No results'
  }

  move(d) {
    if (!this.flat.length) return
    this.sel = Math.max(0, Math.min(this.flat.length - 1, this.sel + d))
    for (const r of this.results.querySelectorAll('.sv-match')) r.classList.toggle('sel', +r.dataset.i === this.sel)
    this.results.querySelector('.sv-match.sel')?.scrollIntoView({ block: 'nearest' })
  }

  open(m, focus) {
    if (m) this.onOpen(m.path, m.line, m.col, m.len, focus)
  }

  focus(prefill) {
    if (prefill) this.q.value = prefill
    this.q.focus()
    this.q.select()
  }
}
