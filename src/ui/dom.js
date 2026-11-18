export function el(tag, cls, attrs) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v
      else if (k === 'html') node.innerHTML = v
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v)
    }
  }
  return node
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
export const esc = s => String(s).replace(/[&<>"]/g, c => ESC[c])

export const basename = p => p.slice(p.lastIndexOf('/') + 1)
export const dirname = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

export function debounce(fn, ms) {
  let t
  const d = (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
  d.flush = (...args) => {
    clearTimeout(t)
    fn(...args)
  }
  return d
}

const ICONS = {
  newFile: '<path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z"/><path d="M9 1.5v4h4M8 8v4M6 10h4"/>',
  newFolder: '<path d="M1.5 3.5a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="M8 7v4M6 9h4"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/>',
  collapse: '<path d="M4 6l4-3 4 3M4 13l4-3 4 3"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  trash: '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/>',
  clear: '<path d="M3 13h10M5 10l6-7M4 4l3 3"/>',
  maximize: '<path d="M3 10l5-5 5 5"/>',
  restore: '<path d="M3 6l5 5 5-5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  play: '<path d="M5 3l8 5-8 5z"/>',
  build: '<path d="M9.5 2.5l4 4-2 2-4-4zM7.5 4.5l-5.5 5.5 4 4 5.5-5.5"/>',
  stop: '<rect x="4" y="4" width="8" height="8"/>',
  files: '<path d="M3 1.5h5l3 3v8H3z"/><path d="M8 1.5v3h3M5.5 14.5h8v-8"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l4 4"/>',
  terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M4 6l2.5 2L4 10M8 11h4"/>',
  sidebar: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M6 2.5v11"/>',
  panel: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 9.5h13"/>',
  interrupt: '<path d="M4 4l8 8M12 4l-8 8"/><circle cx="8" cy="8" r="6.5"/>',
}

export function icon(name) {
  return `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ''}</svg>`
}

export function iconButton(name, title, onclick) {
  return el('button', 'ibtn', { type: 'button', title, 'aria-label': title, html: icon(name), onclick })
}
