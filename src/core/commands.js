import * as keyboard from './keyboard.js'
import { quickPick } from '../ui/quickpick.js'
import { notify } from '../ui/dialog.js'

const commands = new Map()
let recent = []

export function register(id, title, run, { key, when, category, hidden } = {}) {
  commands.set(id, { id, title, run, category, when, hidden })
  if (key) keyboard.bind(id, key, when)
}

export function has(id) {
  return commands.has(id)
}

export function title(id) {
  const c = commands.get(id)
  return c ? (c.category ? c.category + ': ' : '') + c.title : id
}

export async function execute(id, ...args) {
  const cmd = commands.get(id)
  if (!cmd) return notify(`Unknown command: ${id}`, 'error')
  try {
    return await cmd.run(...args)
  } catch (e) {
    console.error(e)
    notify(e.message || String(e), 'error')
  }
}

export function keyHint(id) {
  const keys = keyboard.keysFor(id)
  return keys.length ? keyboard.formatKey(keys[0]) : ''
}

export function list() {
  return [...commands.values()]
}

export function setRecent(list) {
  recent = Array.isArray(list) ? list.slice(0, 20) : []
}
export const getRecent = () => recent

export function palette(initial = '') {
  const items = list()
    .filter(c => !c.hidden)
    .map(c => ({ id: c.id, label: (c.category ? c.category + ': ' : '') + c.title, hint: keyHint(c.id) }))
  items.sort((a, b) => {
    const ra = recent.indexOf(a.id)
    const rb = recent.indexOf(b.id)
    if (ra !== rb) return (ra < 0 ? 1e9 : ra) - (rb < 0 ? 1e9 : rb)
    return a.label.localeCompare(b.label)
  })
  quickPick({
    placeholder: 'Type a command',
    value: initial,
    items,
    onAccept: item => {
      recent = [item.id, ...recent.filter(r => r !== item.id)].slice(0, 20)
      setTimeout(() => execute(item.id), 0)
    },
  })
}
