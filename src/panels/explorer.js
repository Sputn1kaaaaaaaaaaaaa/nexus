import { get } from '../core/api.js'
import { el, esc, dirname, iconButton } from '../ui/dom.js'
import { showMenu } from '../ui/menu.js'
import { notify } from '../ui/dialog.js'

// Lazy-loaded project tree with full keyboard navigation:
// arrows move/expand/collapse, Enter opens, Space previews, F2 renames, Delete deletes,
// Shift+F10 / ContextMenu opens actions, and typing jumps to matching names.
export class Explorer {
  constructor(actions) {
    this.actions = actions
    this.root = { path: '', name: '', type: 'dir', children: null, depth: -1 }
    this.expanded = new Set([''])
    this.sel = null
    this.activePath = null
    this.rows = []
    this.typeBuf = ''
    this.typeTimer = 0

    this.el = el('div', 'explorer', { tabindex: '0', role: 'tree', 'aria-label': 'Files' })
    this.tools = el('div', 'tools')
    this.tools.append(
      iconButton('newFile', 'New File (Ctrl+Shift+N)', () => this.actions.newFile(this.targetDir())),
      iconButton('newFolder', 'New Folder', () => this.actions.newFolder(this.targetDir())),
      iconButton('refresh', 'Refresh', () => this.refresh()),
      iconButton('collapse', 'Collapse All', () => this.collapseAll()),
    )
    this.el.addEventListener('keydown', e => this.onKey(e))
    this.el.addEventListener('click', e => {
      const row = e.target.closest('.ex-row')
      if (!row) return
      const node = this.find(row.dataset.path)
      this.select(node)
      if (node.type === 'dir') this.toggle(node)
      else this.actions.open(node.path, { focus: true })
    })
    this.el.addEventListener('contextmenu', e => {
      e.preventDefault()
      const row = e.target.closest('.ex-row')
      const node = row ? this.find(row.dataset.path) : this.root
      if (row) this.select(node)
      this.contextMenu(node, { x: e.clientX, y: e.clientY })
    })
  }

  setRootName(name) {
    this.root.name = name
  }

  async load(node) {
    try {
      const list = await get('/api/tree', { path: node.path })
      const old = new Map((node.children || []).map(c => [c.name, c]))
      node.children = list.map(e => {
        const prev = old.get(e.name)
        if (prev && prev.type === e.type) return prev
        return { name: e.name, type: e.type, path: node.path ? node.path + '/' + e.name : e.name, children: null, depth: node.depth + 1 }
      })
    } catch (e) {
      node.children = []
      if (node === this.root) notify('Cannot read project: ' + e.message, 'error')
    }
  }

  async refresh() {
    const walk = async node => {
      if (node.type !== 'dir' || !this.expanded.has(node.path)) return
      await this.load(node)
      await Promise.all(node.children.map(walk))
    }
    await walk(this.root)
    for (const p of [...this.expanded]) if (p && !this.find(p)) this.expanded.delete(p)
    this.render()
  }

  find(path) {
    if (path === '' || path == null) return this.root
    let node = this.root
    for (const part of path.split('/')) {
      node = node.children?.find(c => c.name === part)
      if (!node) return null
    }
    return node
  }

  async toggle(node, open = !this.expanded.has(node.path)) {
    if (node.type !== 'dir' || node === this.root) return
    if (open) {
      this.expanded.add(node.path)
      if (!node.children) await this.load(node)
    } else this.expanded.delete(node.path)
    this.render()
  }

  collapseAll() {
    this.expanded = new Set([''])
    this.render()
  }

  // Expands ancestors of `path` and highlights it.
  async reveal(path, { select = true } = {}) {
    this.activePath = path
    const parts = path.split('/')
    let node = this.root
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children) await this.load(node)
      node = node.children.find(c => c.name === parts[i])
      if (!node) return this.render()
      this.expanded.add(node.path)
      if (!node.children) await this.load(node)
    }
    if (select) this.sel = path
    this.render()
    this.el.querySelector('.ex-row.sel')?.scrollIntoView({ block: 'nearest' })
  }

  targetDir() {
    const node = this.find(this.sel)
    if (!node) return ''
    return node.type === 'dir' ? node.path : dirname(node.path)
  }

  select(node) {
    if (!node) return
    this.sel = node.path
    for (const r of this.el.querySelectorAll('.ex-row')) r.classList.toggle('sel', r.dataset.path === node.path)
    this.el.querySelector('.ex-row.sel')?.scrollIntoView({ block: 'nearest' })
  }

  render() {
    this.rows = []
    const visit = node => {
      for (const c of node.children || []) {
        this.rows.push(c)
        if (c.type === 'dir' && this.expanded.has(c.path)) visit(c)
      }
    }
    visit(this.root)
    if (!this.rows.length) {
      this.el.innerHTML = `<div class="empty">${this.root.children ? 'Empty folder. Press Ctrl+Shift+N to create a file.' : 'Loading…'}</div>`
      return
    }
    let html = ''
    for (const n of this.rows) {
      const open = this.expanded.has(n.path)
      const cls = 'ex-row' + (n.type === 'dir' ? ' dir' : '') + (n.path === this.sel ? ' sel' : '') +
        (n.path === this.activePath ? ' active' : '') + (n.name[0] === '.' ? ' hidden' : '')
      html += `<div class="${cls}" data-path="${esc(n.path)}" role="treeitem" aria-label="${esc(n.name)}" style="padding-left:${n.depth * 12 + 4}px"` +
        `${n.type === 'dir' ? ` aria-expanded="${open}"` : ''}>` +
        `<span class="ex-twisty">${n.type === 'dir' ? (open ? '▾' : '▸') : ''}</span>${esc(n.name)}</div>`
    }
    this.el.innerHTML = html
  }

  contextMenu(node, at) {
    const dir = node.type === 'dir' ? node.path : dirname(node.path)
    const isRoot = node === this.root
    const items = [
      { label: 'New File…', run: () => this.actions.newFile(dir) },
      { label: 'New Folder…', run: () => this.actions.newFolder(dir) },
    ]
    if (!isRoot) {
      items.push(
        { sep: true },
        { label: 'Rename…', hint: 'F2', run: () => this.actions.rename(node.path) },
        { label: 'Delete', hint: 'Del', run: () => this.actions.remove(node.path) },
      )
    }
    items.push(
      { sep: true },
      { label: 'Copy Relative Path', run: () => this.actions.copyPath(node.path, false) },
      { label: 'Copy Absolute Path', run: () => this.actions.copyPath(node.path, true) },
      { label: 'Open in Terminal', run: () => this.actions.terminalHere(dir) },
      { sep: true },
      { label: 'Refresh', run: () => this.refresh() },
    )
    showMenu(items, at)
  }

  onKey(e) {
    const i = this.rows.findIndex(r => r.path === this.sel)
    const node = this.rows[i]
    const k = e.key
    if (e.ctrlKey || e.metaKey) return
    if (k === 'ArrowDown') this.select(this.rows[Math.min(this.rows.length - 1, i + 1)])
    else if (k === 'ArrowUp') this.select(this.rows[Math.max(0, i - 1)])
    else if (k === 'Home') this.select(this.rows[0])
    else if (k === 'End') this.select(this.rows[this.rows.length - 1])
    else if (k === 'PageDown') this.select(this.rows[Math.min(this.rows.length - 1, i + 15)])
    else if (k === 'PageUp') this.select(this.rows[Math.max(0, i - 15)])
    else if (k === 'ArrowRight' && node) {
      if (node.type === 'dir' && !this.expanded.has(node.path)) this.toggle(node, true)
      else if (node.type === 'dir') this.select(this.rows[i + 1]?.depth > node.depth ? this.rows[i + 1] : node)
    } else if (k === 'ArrowLeft' && node) {
      if (node.type === 'dir' && this.expanded.has(node.path)) this.toggle(node, false)
      else this.select(this.find(dirname(node.path)) === this.root ? node : this.find(dirname(node.path)))
    } else if (k === 'Enter' && node) {
      if (node.type === 'dir') this.toggle(node)
      else this.actions.open(node.path, { focus: true })
    } else if (k === ' ' && node) {
      if (node.type === 'dir') this.toggle(node)
      else this.actions.open(node.path, { focus: false })
    } else if (k === 'F2' && node) this.actions.rename(node.path)
    else if (k === 'Delete' && node) this.actions.remove(node.path)
    else if ((k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) && (node || this.root)) {
      const row = this.el.querySelector('.ex-row.sel')
      const r = row ? row.getBoundingClientRect() : this.el.getBoundingClientRect()
      this.contextMenu(node || this.root, { x: r.left + 20, y: r.bottom })
    } else if (k.length === 1 && !e.altKey && /\S/.test(k)) {
      clearTimeout(this.typeTimer)
      this.typeBuf += k.toLowerCase()
      this.typeTimer = setTimeout(() => (this.typeBuf = ''), 700)
      const start = this.typeBuf.length === 1 ? i + 1 : Math.max(0, i)
      for (let n = 0; n < this.rows.length; n++) {
        const r = this.rows[(start + n) % this.rows.length]
        if (r.name.toLowerCase().startsWith(this.typeBuf)) {
          this.select(r)
          break
        }
      }
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  focus() {
    this.el.focus({ preventScroll: true })
    if (!this.sel && this.rows.length) this.select(this.rows[0])
  }
}
