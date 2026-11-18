import { el, esc } from './dom.js'

const MAX_ITEMS = 150

// Returns { score, hits } or null. Contiguous and word-start matches score higher.
export function fuzzy(query, text) {
  if (!query) return { score: 0, hits: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const idx = t.indexOf(q)
  if (idx >= 0) {
    const boundary = idx === 0 || /[\/\s._\-:]/.test(text[idx - 1])
    return { score: 1000 - idx - t.length * 0.5 + (boundary ? 300 : 0), hits: Array.from(q, (_, k) => idx + k) }
  }
  const hits = []
  let score = 0
  let j = 0
  let run = 0
  for (let i = 0; i < t.length && j < q.length; i++) {
    if (t[i] !== q[j]) {
      run = 0
      continue
    }
    hits.push(i)
    run++
    score += run * 5 + (i === 0 || /[\/\s._\-:A-Z]/.test(text[i - 1]) || /[A-Z]/.test(text[i]) ? 20 : 0)
    j++
  }
  if (j < q.length) return null
  return { score: score - t.length * 0.5 - (hits[hits.length - 1] - hits[0]), hits }
}

export function fuzzyPath(query, path) {
  const slash = path.lastIndexOf('/')
  const base = path.slice(slash + 1)
  const b = fuzzy(query, base)
  if (b) return { score: b.score + 2000, hits: b.hits.map(h => h + slash + 1) }
  return fuzzy(query.replace(/\s+/g, ''), path)
}

export function marked(text, hits) {
  if (!hits || !hits.length) return esc(text)
  const set = new Set(hits)
  let out = ''
  for (let i = 0; i < text.length; i++) out += set.has(i) ? `<b>${esc(text[i])}</b>` : esc(text[i])
  return out
}

let active = null

export const isOpen = () => !!active

// items: [{label, detail?, hint?, ...}] or provider(query) -> items (may be async).
// onAccept(item, query) returning false keeps the picker open.
export function quickPick(opts) {
  if (active) active.close(false)
  const prevFocus = document.activeElement
  const overlay = el('div', 'modal qp-overlay')
  const box = el('div', 'qp', { role: 'dialog', 'aria-label': opts.placeholder || 'Quick pick' })
  const input = el('input', 'qp-input', {
    type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
    placeholder: opts.placeholder || '', 'aria-autocomplete': 'list',
  })
  const title = opts.title ? el('div', 'qp-title', { text: opts.title }) : null
  const listEl = el('div', 'qp-list', { role: 'listbox' })
  if (title) box.append(title)
  box.append(input, listEl)
  overlay.append(box)
  document.body.append(overlay)

  let items = []
  let sel = 0
  let seq = 0
  let shownQuery = null
  let pending = Promise.resolve()

  const filter = (list, q) => {
    if (!q) return list.slice(0, MAX_ITEMS)
    const scored = []
    for (const it of list) {
      const m = opts.matchPath ? fuzzyPath(q, it.label) : fuzzy(q, it.label)
      if (m) scored.push({ ...it, hits: m.hits, score: m.score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, MAX_ITEMS)
  }

  function update() {
    pending = load()
    return pending
  }

  async function load() {
    const q = input.value
    const my = ++seq
    let list
    if (opts.provider) list = await opts.provider(q)
    else list = filter(opts.items || [], q)
    if (my !== seq || !active) return
    shownQuery = q
    items = list || []
    sel = Math.min(sel, Math.max(0, items.length - 1))
    if (opts.resetSelection !== false) sel = 0
    render()
  }

  function render() {
    listEl.innerHTML = ''
    if (!items.length) {
      listEl.append(el('div', 'qp-empty', { text: opts.emptyText || 'No matches' }))
      return
    }
    items.forEach((it, i) => {
      const row = el('div', 'qp-item' + (i === sel ? ' sel' : ''), { role: 'option', 'aria-selected': i === sel })
      row.innerHTML =
        `<span class="qp-label">${marked(it.label, it.hits)}</span>` +
        (it.detail ? `<span class="qp-detail">${esc(it.detail)}</span>` : '') +
        (it.hint ? `<kbd>${esc(it.hint)}</kbd>` : '')
      row.addEventListener('mousedown', e => e.preventDefault())
      row.addEventListener('click', () => {
        sel = i
        accept()
      })
      listEl.append(row)
    })
    listEl.children[sel]?.scrollIntoView({ block: 'nearest' })
  }

  function move(d) {
    if (!items.length) return
    sel = (sel + d + items.length) % items.length
    render()
  }

  async function accept() {
    if (shownQuery !== input.value) await update()
    else await pending
    const it = items[sel]
    if (!it && !opts.acceptEmpty) return
    const keep = await opts.onAccept?.(it, input.value)
    if (keep === false) {
      update()
      return
    }
    close(false)
  }

  function close(restore = true) {
    if (!active || active.overlay !== overlay) return
    active = null
    overlay.remove()
    opts.onClose?.()
    if (restore && prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true })
  }

  input.addEventListener('input', () => {
    opts.onInput?.(input.value, api)
    update()
  })
  input.addEventListener('keydown', e => {
    const k = e.key
    if (opts.onKey && opts.onKey(e, input.value, api)) {
      e.preventDefault()
      return
    }
    if (k === 'ArrowDown' || (e.ctrlKey && k === 'n')) move(1)
    else if (k === 'ArrowUp' || (e.ctrlKey && k === 'p' && !e.shiftKey)) move(-1)
    else if (k === 'PageDown') move(Math.min(10, items.length - 1 - sel) || 1)
    else if (k === 'PageUp') move(-Math.min(10, sel) || -1)
    else if (k === 'Enter') accept()
    else if (k === 'Escape') close()
    else if (k === 'Tab') {
      if (opts.onTab) opts.onTab(items[sel], api)
    } else return
    e.preventDefault()
    e.stopPropagation()
  })
  overlay.addEventListener('mousedown', e => {
    if (e.target === overlay) {
      e.preventDefault()
      close()
    }
  })

  const api = {
    overlay,
    input,
    close,
    refresh: update,
    setValue(v) {
      input.value = v
      update()
    },
    get selected() {
      return items[sel]
    },
  }
  active = api
  input.value = opts.value || ''
  input.focus()
  if (opts.selectValue) input.select()
  update()
  return api
}
