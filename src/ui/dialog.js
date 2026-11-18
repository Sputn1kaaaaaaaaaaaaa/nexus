import { el, esc } from './dom.js'

let logHook = null
export function onNotify(fn) {
  logHook = fn
}

function modal(build) {
  const prevFocus = document.activeElement
  const overlay = el('div', 'modal dlg-overlay')
  const box = el('div', 'dlg', { role: 'dialog', 'aria-modal': 'true' })
  overlay.append(box)
  document.body.append(overlay)
  const done = () => {
    overlay.remove()
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true })
  }
  build(box, done)
  return overlay
}

export function prompt({ title, value = '', placeholder = '', select, validate }) {
  return new Promise(resolve => {
    modal((box, done) => {
      const label = el('div', 'dlg-title', { text: title })
      const input = el('input', 'dlg-input', { type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', placeholder })
      const msg = el('div', 'dlg-msg')
      box.append(label, input, msg)
      input.value = value
      input.focus()
      if (select) input.setSelectionRange(select[0], select[1])
      else input.select()
      const check = () => {
        const err = validate ? validate(input.value) : ''
        msg.textContent = err || ''
        msg.classList.toggle('err', !!err)
        return !err
      }
      input.addEventListener('input', check)
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (!check()) return
          done()
          resolve(input.value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          done()
          resolve(null)
        }
      })
      box.parentElement.addEventListener('mousedown', e => {
        if (e.target === box.parentElement) {
          e.preventDefault()
          done()
          resolve(null)
        }
      })
    })
  })
}

// Resolves with the index of the chosen button, or `cancel` on Escape.
export function confirm({ title, message = '', buttons = ['OK', 'Cancel'], cancel = buttons.length - 1, danger }) {
  return new Promise(resolve => {
    modal((box, done) => {
      box.append(el('div', 'dlg-title', { text: title }))
      if (message) box.append(el('div', 'dlg-text', { html: esc(message).replace(/\n/g, '<br>') }))
      const row = el('div', 'dlg-buttons')
      const btns = buttons.map((b, i) => {
        const btn = el('button', 'btn' + (i === 0 ? (danger ? ' danger' : ' primary') : ''), { type: 'button', text: b })
        btn.addEventListener('click', () => {
          done()
          resolve(i)
        })
        row.append(btn)
        return btn
      })
      box.append(row)
      btns[0].focus()
      box.addEventListener('keydown', e => {
        const i = btns.indexOf(document.activeElement)
        if (e.key === 'Escape') {
          done()
          resolve(cancel)
        } else if (e.key === 'Enter' && i >= 0) {
          done()
          resolve(i)
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
          btns[(i + 1) % btns.length].focus()
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
          btns[(i - 1 + btns.length) % btns.length].focus()
        } else return
        e.preventDefault()
        e.stopPropagation()
      })
    })
  })
}

let toastBox = null
export function notify(message, type = 'info') {
  logHook?.(message, type)
  if (!toastBox) {
    toastBox = el('div', 'toasts', { 'aria-live': 'polite' })
    document.body.append(toastBox)
  }
  const t = el('div', 'toast ' + type, { text: message, title: 'Click to dismiss' })
  t.addEventListener('click', () => t.remove())
  toastBox.append(t)
  while (toastBox.children.length > 3) toastBox.firstChild.remove()
  setTimeout(() => t.remove(), type === 'error' ? 7000 : 3500)
}

export function dismissToasts() {
  if (!toastBox || !toastBox.children.length) return false
  toastBox.innerHTML = ''
  return true
}
