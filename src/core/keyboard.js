// Keybinding registry. Bindings are matched on a normalized string such as "ctrl+shift+p".
// The dispatcher runs in the bubble phase, so focused widgets (editor, terminal, dialogs)
// can consume keys first by calling preventDefault().

const CODE_KEYS = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'space',
}
const KEY_ALIASES = {
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', ' ': 'space',
  esc: 'escape', del: 'delete', return: 'enter', pgup: 'pageup', pgdn: 'pagedown', plus: '=',
}
const MODS = ['ctrl', 'alt', 'shift', 'meta']

export function normalize(str) {
  const parts = str.toLowerCase().split('+').map(s => s.trim())
  let key = parts.pop()
  if (key === '' && parts[parts.length - 1] === '') {
    parts.pop()
    key = '+'
  }
  key = KEY_ALIASES[key] || key
  if (key === 'cmd') key = 'meta'
  const mods = MODS.filter(m => parts.includes(m) || (m === 'meta' && parts.includes('cmd')))
  return [...mods, key].join('+')
}

export function eventKey(e) {
  let key
  if (e.code && e.code.startsWith('Key')) key = e.code.slice(3).toLowerCase()
  else if (e.code && e.code.startsWith('Digit')) key = e.code.slice(5)
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code]
  else key = (e.key || '').toLowerCase()
  // Prefer the produced letter on non-QWERTY layouts.
  if (e.key && e.key.length === 1 && /[a-z]/i.test(e.key) && !e.altKey) key = e.key.toLowerCase()
  key = KEY_ALIASES[key] || key
  if (['control', 'shift', 'alt', 'meta', 'os'].includes(key)) return null
  const mods = []
  if (e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  if (e.metaKey) mods.push('meta')
  return [...mods, key].join('+')
}

const KEY_LABELS = { up: '↑', down: '↓', left: '←', right: '→', escape: 'Esc', space: 'Space', pagedown: 'PgDn', pageup: 'PgUp' }
export function formatKey(norm) {
  if (!norm) return ''
  return norm.split('+').map(p => KEY_LABELS[p] || (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join('+')
}

const defaults = new Map() // command -> [keys]
let overrides = {}
let table = new Map() // normalized key -> [{command, when}]
const whens = new Map() // command -> when()
let runner = null
let contextFn = () => ({})

export function bind(command, keys, when) {
  if (!keys) return
  defaults.set(command, (Array.isArray(keys) ? keys : [keys]).map(normalize))
  if (when) whens.set(command, when)
  rebuild()
}

export function setOverrides(map) {
  overrides = map && typeof map === 'object' ? map : {}
  rebuild()
}

export function keysFor(command) {
  if (command in overrides) {
    const v = overrides[command]
    return (Array.isArray(v) ? v : v ? [v] : []).map(normalize)
  }
  return defaults.get(command) || []
}

function rebuild() {
  table = new Map()
  const commands = new Set([...defaults.keys(), ...Object.keys(overrides)])
  for (const command of commands) {
    for (const k of keysFor(command)) {
      if (!table.has(k)) table.set(k, [])
      table.get(k).push({ command, when: whens.get(command) })
    }
  }
}

export function init({ run, context }) {
  runner = run
  contextFn = context
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.isComposing) return
    const k = eventKey(e)
    if (!k) return
    const entries = table.get(k)
    if (!entries) return
    const ctx = contextFn()
    if (ctx.modal) return
    for (const { command, when } of entries) {
      if (when && !when(ctx)) continue
      e.preventDefault()
      e.stopPropagation()
      runner(command)
      return
    }
  })
}
