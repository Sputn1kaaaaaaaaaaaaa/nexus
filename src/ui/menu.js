import { el, esc } from './dom.js'

let current = null

export const menuOpen = () => !!current

export function closeMenu(restore = true) {
  if (!current) return
  const c = current
  current = null
  c.overlay.remove()
  c.onClose?.()
  if (restore && c.prevFocus && document.contains(c.prevFocus)) c.prevFocus.focus({ preventScroll: true })
}

// items: [{label, hint, run, disabled} | {sep: true}]
// at: {x, y} in viewport pixels, or an anchor element.
export function showMenu(items, at, { onNav, onClose, focusFirst = true } = {}) {
  const prevFocus = current ? current.prevFocus : document.activeElement
  if (current) closeMenu(false)
  const overlay = el('div', 'modal menu-overlay')
  const box = el('div', 'menu', { role: 'menu' })
  const rows = []
  for (const it of items) {
    if (it.sep) {
      box.append(el('div', 'menu-sep'))
      continue
    }
    const row = el('button', 'menu-item', { type: 'button', role: 'menuitem', disabled: !!it.disabled })
    row.innerHTML = `<span>${esc(it.label)}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}`
    row.addEventListener('click', () => {
      closeMenu()
      setTimeout(() => it.run?.(), 0)
    })
    row.addEventListener('mouseenter', () => row.focus({ preventScroll: true }))
    box.append(row)
    if (!it.disabled) rows.push(row)
  }
  overlay.append(box)
  document.body.append(overlay)

  let x, y
  if (at instanceof Element) {
    const r = at.getBoundingClientRect()
    x = r.left
    y = r.bottom
  } else ({ x, y } = at)
  const bw = box.offsetWidth
  const bh = box.offsetHeight
  box.style.left = Math.max(2, Math.min(x, innerWidth - bw - 2)) + 'px'
  box.style.top = Math.max(2, y + bh > innerHeight - 2 ? Math.max(2, y - bh) : y) + 'px'

  overlay.addEventListener('mousedown', e => {
    if (e.target === overlay) {
      e.preventDefault()
      closeMenu()
    }
  })
  overlay.addEventListener('contextmenu', e => e.preventDefault())
  box.addEventListener('keydown', e => {
    const i = rows.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') rows[(i + 1) % rows.length]?.focus()
    else if (e.key === 'ArrowUp') rows[(i - 1 + rows.length) % rows.length]?.focus()
    else if (e.key === 'Home') rows[0]?.focus()
    else if (e.key === 'End') rows[rows.length - 1]?.focus()
    else if (e.key === 'Escape') closeMenu()
    else if (e.key === 'Tab') closeMenu()
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && onNav) onNav(e.key === 'ArrowLeft' ? -1 : 1)
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
      const ch = e.key.toLowerCase()
      const start = i + 1
      for (let k = 0; k < rows.length; k++) {
        const r = rows[(start + k) % rows.length]
        if (r.textContent.trim().toLowerCase().startsWith(ch)) {
          r.focus()
          break
        }
      }
    } else return
    e.preventDefault()
    e.stopPropagation()
  })
  current = { overlay, prevFocus, onClose }
  if (focusFirst) rows[0]?.focus()
  else box.tabIndex = -1, box.focus()
}
