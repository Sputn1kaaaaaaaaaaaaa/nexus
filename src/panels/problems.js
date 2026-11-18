import { el, esc, iconButton } from '../ui/dom.js'

// Problems come from two sources: live editor diagnostics (per document) and the
// problem matchers applied to build/run output (replaced on each task run).
export class ProblemsPanel {
  constructor({ onOpen, onChange }) {
    this.onOpen = onOpen
    this.onChange = onChange
    this.editor = new Map()
    this.task = []
    this.flat = []
    this.sel = -1
    this.el = el('div', 'problems', { tabindex: '0', role: 'tree', 'aria-label': 'Problems' })
    this.tools = el('div', 'tools')
    this.tools.append(iconButton('clear', 'Clear Build Problems', () => this.setTask([])))
    this.el.addEventListener('keydown', e => this.onKey(e))
    this.render()
  }

  setEditor(path, list) {
    if (list.length) this.editor.set(path, list)
    else this.editor.delete(path)
    this.render()
  }

  renameEditor(oldPath, newPath) {
    const list = this.editor.get(oldPath)
    if (!list) return
    this.editor.delete(oldPath)
    this.editor.set(newPath, list)
    this.render()
  }

  setTask(list) {
    this.task = list
    this.render()
  }

  forPath(path) {
    return this.task.filter(p => p.path === path)
  }

  all() {
    const byPath = new Map()
    const add = p => {
      if (!byPath.has(p.path)) byPath.set(p.path, [])
      byPath.get(p.path).push(p)
    }
    for (const p of this.task) add(p)
    for (const [path, list] of this.editor) for (const p of list) add({ ...p, path, source: 'editor' })
    for (const list of byPath.values()) list.sort((a, b) => (a.line || 0) - (b.line || 0) || (a.col || 0) - (b.col || 0))
    return byPath
  }

  counts() {
    let errors = 0
    let warnings = 0
    for (const list of this.all().values()) for (const p of list) p.severity === 'error' ? errors++ : warnings++
    return { errors, warnings }
  }

  render() {
    const groups = this.all()
    this.flat = []
    let html = ''
    for (const [path, list] of groups) {
      html += `<div class="pb-file">${esc(path)}<span class="count">${list.length}</span></div>`
      for (const p of list) {
        const i = this.flat.length
        this.flat.push(p)
        const icon = p.severity === 'error' ? '✕' : p.severity === 'warning' ? '!' : 'i'
        html += `<div class="pb-row ${p.severity}${i === this.sel ? ' sel' : ''}" data-i="${i}" role="treeitem">` +
          `<span class="pb-icon">${icon}</span><span class="pb-msg">${esc(p.message)}</span>` +
          `<span class="pb-loc">${p.source === 'editor' ? '' : esc(p.source || '') + ' '}${p.line ? `[${p.line}${p.col ? ':' + p.col : ''}]` : ''}</span></div>`
      }
    }
    this.el.innerHTML = html || '<div class="empty">No problems detected.</div>'
    for (const row of this.el.querySelectorAll('.pb-row')) {
      row.addEventListener('click', () => {
        this.sel = +row.dataset.i
        this.open(this.flat[this.sel])
      })
    }
    this.onChange?.(this.counts())
  }

  open(p) {
    if (p) this.onOpen(p.path, p.line, p.col)
  }

  move(d) {
    if (!this.flat.length) return
    this.sel = Math.max(0, Math.min(this.flat.length - 1, this.sel + d))
    for (const row of this.el.querySelectorAll('.pb-row')) row.classList.toggle('sel', +row.dataset.i === this.sel)
    this.el.querySelector(`.pb-row[data-i="${this.sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  // F8 / Shift+F8 navigation; opens the problem.
  step(dir) {
    if (!this.flat.length) return false
    this.sel = this.sel < 0 ? (dir > 0 ? 0 : this.flat.length - 1) : (this.sel + dir + this.flat.length) % this.flat.length
    this.move(0)
    this.open(this.flat[this.sel])
    return true
  }

  onKey(e) {
    if (e.key === 'ArrowDown') this.move(1)
    else if (e.key === 'ArrowUp') this.move(-1)
    else if (e.key === 'Home') this.move(-1e9)
    else if (e.key === 'End') this.move(1e9)
    else if (e.key === 'Enter') this.open(this.flat[this.sel])
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  focus() {
    this.el.focus({ preventScroll: true })
    if (this.sel < 0 && this.flat.length) this.move(1)
  }
}
