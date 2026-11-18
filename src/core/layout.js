import { el, esc } from '../ui/dom.js'

const NARROW = 640

// Owns the workbench layout: sidebar (docked, or a drawer on narrow screens), the panel
// (bottom, or right on short landscape screens), sizes, and focus regions for F6.
export class Layout {
  constructor({ app, onChange, focusEditor }) {
    this.app = app
    this.onChange = onChange
    this.focusEditor = focusEditor
    this.sidebar = document.getElementById('sidebar')
    this.panel = document.getElementById('panel')
    this.center = document.getElementById('center')
    this.sideTabs = this.sidebar.querySelector('.side-tabs')
    this.sideActions = this.sidebar.querySelector('.side-actions')
    this.sideBody = this.sidebar.querySelector('.side-body')
    this.panelTabs = this.panel.querySelector('.panel-tabs')
    this.panelTools = this.panel.querySelector('.panel-tools')
    this.panelBody = this.panel.querySelector('.panel-body')
    this.sideViews = new Map()
    this.panelViews = new Map()
    this.s = {
      sidebar: innerWidth >= NARROW,
      sideView: 'explorer',
      sideWidth: 210,
      panel: true,
      panelView: 'terminal',
      panelSize: 0.38,
      panelMax: false,
      position: 'auto',
    }
    this.narrow = false
    this.panelRight = false

    this.sash(document.getElementById('sash-side'), 'side')
    this.sash(document.getElementById('sash-panel'), 'panel')
    addEventListener('resize', () => this.apply())
    this.center.addEventListener('mousedown', () => {
      if (this.narrow && this.s.sidebar) this.toggleSidebar(false)
    })
  }

  addSideView(id, title, view) {
    this.sideViews.set(id, view)
    view.el.style.display = 'none'
    this.sideBody.append(view.el)
    const tab = el('button', 'side-tab', { type: 'button', role: 'tab', text: title })
    tab.dataset.id = id
    tab.addEventListener('click', () => this.showSide(id, true))
    this.sideTabs.append(tab)
  }

  addPanelView(id, title, view) {
    this.panelViews.set(id, view)
    view.el.style.display = 'none'
    this.panelBody.append(view.el)
    const tab = el('button', 'panel-tab', { type: 'button', role: 'tab', html: `${esc(title)}<span class="badge"></span>` })
    tab.dataset.id = id
    tab.addEventListener('click', () => this.showPanel(id, true))
    this.panelTabs.append(tab)
  }

  setBadge(id, text) {
    const b = this.panelTabs.querySelector(`[data-id="${id}"] .badge`)
    if (b) b.textContent = text || ''
  }

  showSide(id, focus = false) {
    this.s.sideView = id
    this.s.sidebar = true
    this.apply()
    if (focus) this.sideViews.get(id)?.focus()
  }

  showPanel(id, focus = false) {
    this.s.panelView = id
    this.s.panel = true
    this.apply()
    if (focus) this.panelViews.get(id)?.focus()
  }

  toggleSidebar(on = !this.s.sidebar) {
    const had = this.sidebar.contains(document.activeElement)
    this.s.sidebar = on
    this.apply()
    if (on) this.sideViews.get(this.s.sideView)?.focus()
    else if (had) this.focusEditor()
  }

  togglePanel(on = !this.s.panel) {
    const had = this.panel.contains(document.activeElement)
    this.s.panel = on
    if (!on) this.s.panelMax = false
    this.apply()
    if (!on && had) this.focusEditor()
  }

  toggleMaximize() {
    this.s.panel = true
    this.s.panelMax = !this.s.panelMax
    this.apply()
    if (this.s.panelMax) this.panelViews.get(this.s.panelView)?.focus()
  }

  cyclePosition() {
    const order = ['auto', 'bottom', 'right']
    this.s.position = order[(order.indexOf(this.s.position) + 1) % order.length]
    this.apply()
    return this.s.position
  }

  resizePanel(delta) {
    this.s.panelSize = Math.max(0.15, Math.min(0.85, this.s.panelSize + delta))
    this.apply()
  }

  apply() {
    const s = this.s
    this.narrow = innerWidth < NARROW
    this.panelRight = s.position === 'right' || (s.position === 'auto' && innerWidth > innerHeight && innerHeight < 560 && innerWidth >= NARROW)
    const cl = this.app.classList
    cl.toggle('narrow', this.narrow)
    cl.toggle('sidebar-hidden', !s.sidebar)
    cl.toggle('panel-hidden', !s.panel)
    cl.toggle('panel-max', s.panel && s.panelMax)
    cl.toggle('panel-right', this.panelRight)
    this.app.style.setProperty('--side-w', Math.round(this.narrow ? Math.min(300, innerWidth * 0.85) : s.sideWidth) + 'px')
    this.app.style.setProperty('--panel-size', (s.panelSize * 100).toFixed(1) + '%')
    for (const [id, v] of this.sideViews) v.el.style.display = id === s.sideView ? '' : 'none'
    for (const [id, v] of this.panelViews) v.el.style.display = id === s.panelView ? '' : 'none'
    for (const t of this.sideTabs.children) t.setAttribute('aria-selected', String(t.dataset.id === s.sideView))
    for (const t of this.panelTabs.children) t.setAttribute('aria-selected', String(t.dataset.id === s.panelView))
    const side = this.sideViews.get(s.sideView)
    if (side && this.sideActions.firstChild !== side.tools) this.sideActions.replaceChildren(side.tools || '')
    const pv = this.panelViews.get(s.panelView)
    if (pv && this.panelTools.firstChild !== pv.tools) this.panelTools.replaceChildren(pv.tools || '')
    this.onChange?.()
  }

  sash(handle, kind) {
    handle.addEventListener('pointerdown', e => {
      e.preventDefault()
      handle.setPointerCapture(e.pointerId)
      handle.classList.add('drag')
      const rect = this.center.getBoundingClientRect()
      const move = ev => {
        if (kind === 'side') this.s.sideWidth = Math.max(140, Math.min(innerWidth * 0.6, ev.clientX))
        else if (this.panelRight) this.s.panelSize = Math.max(0.15, Math.min(0.85, (rect.right - ev.clientX) / rect.width))
        else this.s.panelSize = Math.max(0.15, Math.min(0.85, (rect.bottom - ev.clientY) / rect.height))
        this.apply()
      }
      const up = () => {
        handle.classList.remove('drag')
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    })
  }

  region() {
    const a = document.activeElement
    if (this.sidebar.contains(a)) return 'sidebar'
    if (this.panel.contains(a)) return 'panel'
    return 'editor'
  }

  focusRegion(r) {
    if (r === 'sidebar') this.showSide(this.s.sideView, true)
    else if (r === 'panel') this.showPanel(this.s.panelView, true)
    else this.focusEditor()
  }

  // F6 / Shift+F6
  cycleFocus(dir) {
    const regions = []
    if (this.s.sidebar) regions.push('sidebar')
    if (!this.s.panelMax) regions.push('editor')
    if (this.s.panel) regions.push('panel')
    const i = regions.indexOf(this.region())
    this.focusRegion(regions[(i + dir + regions.length) % regions.length])
  }

  getState() {
    return { ...this.s }
  }

  setState(st) {
    if (st) Object.assign(this.s, st)
    if (innerWidth < NARROW) this.s.sidebar = false
    this.apply()
  }
}
