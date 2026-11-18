import { el, esc, dirname, basename } from '../ui/dom.js'
import { confirm } from '../ui/dialog.js'

export class Tabs {
  constructor({ bar, container, fm, onActivate, onEmpty }) {
    this.bar = bar
    this.container = container
    this.fm = fm
    this.onActivate = onActivate
    this.onEmpty = onEmpty
    this.list = []
    this.mru = []
    this.active = null
    this.switcher = null
    bar.addEventListener('wheel', e => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        bar.scrollLeft += e.deltaY
        e.preventDefault()
      }
    }, { passive: false })
  }

  add(doc) {
    if (this.list.includes(doc)) return
    const at = this.active ? this.list.indexOf(this.active) + 1 : this.list.length
    this.list.splice(at, 0, doc)
    doc.view.hide()
    this.container.append(doc.view.el)
    this.render()
  }

  activate(doc, { focus = true } = {}) {
    if (!this.list.includes(doc)) this.add(doc)
    if (this.active && this.active !== doc) this.active.view.hide()
    this.active = doc
    this.mru = [doc, ...this.mru.filter(d => d !== doc)]
    doc.view.show()
    this.render()
    if (focus) doc.view.focus()
    this.onActivate?.(doc)
  }

  async close(doc = this.active, { force = false } = {}) {
    if (!doc) return true
    if (doc.dirty && !force) {
      const choice = await confirm({
        title: `Save changes to ${doc.name}?`,
        message: 'Your changes will be lost if you don\'t save them.',
        buttons: ['Save', 'Don\'t Save', 'Cancel'],
      })
      if (choice === 2) return false
      if (choice === 0 && !(await this.fm.save(doc))) return false
    }
    const idx = this.list.indexOf(doc)
    this.list.splice(idx, 1)
    this.mru = this.mru.filter(d => d !== doc)
    this.fm.docs.delete(doc.path)
    doc.view.destroy()
    if (this.active === doc) {
      this.active = null
      const next = this.mru[0]
      if (next) this.activate(next)
      else {
        this.render()
        this.onEmpty?.()
      }
    } else this.render()
    return true
  }

  async closeAll() {
    for (const doc of [...this.list]) if (!(await this.close(doc))) return false
    return true
  }

  async closeOthers() {
    for (const doc of [...this.list]) if (doc !== this.active && !(await this.close(doc))) return false
    return true
  }

  next(dir) {
    if (this.list.length < 2) return
    const i = this.list.indexOf(this.active)
    this.activate(this.list[(i + dir + this.list.length) % this.list.length])
  }

  at(n) {
    const doc = n === 9 ? this.list[this.list.length - 1] : this.list[n - 1]
    if (doc) this.activate(doc)
  }

  // Ctrl+Tab: hold Ctrl and press Tab repeatedly to walk the most-recently-used list.
  cycle(dir) {
    if (this.mru.length < 2) return
    if (!this.switcher) {
      const box = el('div', 'tab-switcher', { role: 'listbox' })
      document.body.append(box)
      const commit = () => {
        const sw = this.switcher
        if (!sw) return
        this.switcher = null
        box.remove()
        window.removeEventListener('keyup', onUp, true)
        window.removeEventListener('keydown', onDown, true)
        window.removeEventListener('blur', commit)
        if (!sw.cancelled) this.activate(sw.items[sw.idx])
      }
      const onUp = e => {
        if (e.key === 'Control' || e.key === 'Meta') commit()
      }
      const onDown = e => {
        if (e.key === 'Tab' || e.key === 'Control' || e.key === 'Shift' || e.key === 'Meta') return
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') this.switcher.cancelled = true
        else if (e.key === 'ArrowDown') return this.cycleStep(1)
        else if (e.key === 'ArrowUp') return this.cycleStep(-1)
        commit()
      }
      window.addEventListener('keyup', onUp, true)
      window.addEventListener('keydown', onDown, true)
      window.addEventListener('blur', commit)
      this.switcher = { box, items: this.mru.slice(), idx: 0, commit }
    }
    this.cycleStep(dir)
  }

  cycleStep(dir) {
    const sw = this.switcher
    sw.idx = (sw.idx + dir + sw.items.length) % sw.items.length
    sw.box.innerHTML = sw.items
      .map((d, i) => `<div class="${i === sw.idx ? 'sel' : ''}">${esc(d.name)}<span>${esc(dirname(d.path))}</span>${d.dirty ? ' ●' : ''}</div>`)
      .join('')
  }

  render() {
    const names = new Map()
    for (const d of this.list) names.set(d.name, (names.get(d.name) || 0) + 1)
    this.bar.innerHTML = ''
    for (const doc of this.list) {
      const isActive = doc === this.active
      const tab = el('div', 'tab' + (isActive ? ' active' : '') + (doc.dirty ? ' dirty' : '') + (doc.missing ? ' missing' : ''), {
        role: 'tab', 'aria-selected': isActive, title: doc.path + (doc.missing ? ' (deleted on disk)' : ''),
      })
      const hint = names.get(doc.name) > 1 ? basename(dirname(doc.path)) : ''
      tab.innerHTML = `<span class="tab-name">${esc(doc.name)}</span>${hint ? `<span class="tab-hint">${esc(hint)}</span>` : ''}`
      const x = el('button', 'tab-x', { type: 'button', tabindex: '-1', title: 'Close (Ctrl+W)', 'aria-label': 'Close ' + doc.name })
      x.addEventListener('click', e => {
        e.stopPropagation()
        this.close(doc)
      })
      tab.append(x)
      tab.addEventListener('mousedown', e => {
        if (e.button === 1) {
          e.preventDefault()
          this.close(doc)
        }
      })
      tab.addEventListener('click', () => this.activate(doc))
      this.bar.append(tab)
      if (isActive) requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    }
  }
}
