import { post } from '../core/api.js'
import { AnsiWriter } from '../core/ansi.js'
import { el, esc, iconButton } from '../ui/dom.js'
import { notify } from '../ui/dialog.js'

const NEEDS_TTY = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'micro', 'top', 'htop', 'btop', 'tmux', 'screen', 'mc'])
const REPL = { python: 'python -i', python3: 'python3 -i', node: 'node -i' }

// Terminal sessions run on the local NEXUS server (server/terminal.js). Each command is a real
// process; output streams back over Server-Sent Events. There is no PTY, so full-screen
// programs are rejected with an explanation instead of hanging.
export class TerminalPanel {
  constructor({ home, getRoot, history, onExit, onOpenPath, onRunningChange }) {
    this.home = home
    this.getRoot = getRoot
    this.history = history
    this.onExit = onExit
    this.onOpenPath = onOpenPath
    this.onRunningChange = onRunningChange
    this.sessions = new Map()
    this.activeId = null
    this.connected = false
    this.histIdx = -1
    this.draft = ''

    this.el = el('div', 'term')
    this.outWrap = el('div', 'term-outs')
    this.inputRow = el('div', 'term-input-row')
    this.prompt = el('span', 'term-prompt')
    this.input = el('textarea', 'term-input', {
      rows: '1', spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off',
      'aria-label': 'Terminal input',
    })
    this.inputRow.append(this.prompt, this.input)
    this.el.append(this.outWrap, this.inputRow)

    this.select = el('select', 'term-select', { 'aria-label': 'Terminal session', title: 'Terminal session' })
    this.select.addEventListener('change', () => this.activate(this.select.value))
    this.tools = el('div', 'tools')
    this.tools.append(
      this.select,
      iconButton('plus', 'New Terminal (Ctrl+Shift+`)', () => this.create()),
      iconButton('interrupt', 'Interrupt (Ctrl+C)', () => this.interrupt()),
      iconButton('clear', 'Clear (Ctrl+L)', () => this.clear()),
      iconButton('trash', 'Kill Terminal', () => this.kill()),
    )

    this.input.addEventListener('keydown', e => this.onKey(e))
    this.input.addEventListener('input', () => this.autosize())
    this.outWrap.addEventListener('mouseup', () => {
      if (!String(getSelection())) this.input.focus({ preventScroll: true })
    })
    this.outWrap.addEventListener('keydown', e => {
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) this.input.focus()
    })
    this.updatePrompt()
  }

  get active() {
    return this.sessions.get(this.activeId)
  }

  visibleSessions() {
    return [...this.sessions.values()].filter(s => !s.hidden)
  }

  connect() {
    const es = new EventSource('/api/term/events')
    this.es = es
    es.addEventListener('hello', e => {
      this.connected = true
      const { sessions } = JSON.parse(e.data)
      const ids = new Set(sessions.map(s => s.id))
      for (const id of [...this.sessions.keys()]) if (!ids.has(id)) this.drop(id)
      for (const info of sessions) {
        const s = this.ensure(info)
        Object.assign(s, { cwd: info.cwd, running: info.running })
        if (s.writer) {
          s.writer.clear()
          s.writer.reset()
          s.writer.write(info.scrollback || '')
        }
      }
      if (!this.active || this.active.hidden) {
        const first = this.visibleSessions()[0]
        if (first) this.activate(first.id, false)
      }
      this.renderSelect()
      this.updatePrompt()
      this.onRunningChange?.()
    })
    es.addEventListener('created', e => {
      this.ensure(JSON.parse(e.data))
      this.renderSelect()
    })
    es.addEventListener('closed', e => {
      this.drop(JSON.parse(e.data).id)
    })
    es.addEventListener('data', e => {
      const { id, data } = JSON.parse(e.data)
      const s = this.sessions.get(id)
      if (!s) return
      if (s.writer) {
        const stick = this.atBottom(s)
        s.writer.write(data)
        if (stick) s.out.scrollTop = s.out.scrollHeight
      }
      for (const l of s.listeners) l.onData?.(data)
    })
    es.addEventListener('start', e => {
      const { id } = JSON.parse(e.data)
      const s = this.sessions.get(id)
      if (!s) return
      s.running = true
      this.renderSelect()
      if (id === this.activeId) this.updatePrompt()
      this.onRunningChange?.()
    })
    es.addEventListener('exit', e => {
      const info = JSON.parse(e.data)
      const s = this.sessions.get(info.id)
      if (!s) return
      s.running = false
      s.cwd = info.cwd
      this.renderSelect()
      if (info.id === this.activeId) this.updatePrompt()
      for (const l of [...s.listeners]) l.onExit?.(info)
      this.onExit?.(s, info)
      this.onRunningChange?.()
    })
    es.onerror = () => {
      this.connected = false
      this.onRunningChange?.()
    }
  }

  ensure(info) {
    let s = this.sessions.get(info.id)
    if (s) return s
    s = { ...info, listeners: new Set() }
    if (!info.hidden) {
      s.out = el('div', 'term-out', { tabindex: '-1', role: 'log', 'aria-label': 'Terminal output' })
      s.out.style.display = 'none'
      s.writer = new AnsiWriter(s.out, 4000)
      this.outWrap.append(s.out)
    }
    this.sessions.set(info.id, s)
    return s
  }

  drop(id) {
    const s = this.sessions.get(id)
    if (!s) return
    s.out?.remove()
    this.sessions.delete(id)
    if (this.activeId === id) {
      this.activeId = null
      const next = this.visibleSessions()[0]
      if (next) this.activate(next.id, false)
    }
    this.renderSelect()
    this.updatePrompt()
  }

  async create({ name, hidden = false, cwd, focus = true } = {}) {
    const count = this.visibleSessions().length
    const info = await post('/api/term/create', { name: name || (hidden ? 'task' : 'bash ' + (count + 1)), hidden, cwd })
    const s = this.ensure(info)
    this.renderSelect()
    if (!hidden) this.activate(s.id, focus)
    return s
  }

  async ensureSession() {
    if (this.active && !this.active.hidden) return this.active
    const first = this.visibleSessions()[0]
    if (first) {
      this.activate(first.id, false)
      return first
    }
    return this.create({ focus: false })
  }

  activate(id, focus = true) {
    const s = this.sessions.get(id)
    if (!s || s.hidden) return
    if (this.active?.out) this.active.out.style.display = 'none'
    this.activeId = id
    s.out.style.display = ''
    s.out.scrollTop = s.out.scrollHeight
    this.select.value = id
    this.updatePrompt()
    if (focus) this.focus()
  }

  renderSelect() {
    const vis = this.visibleSessions()
    this.select.innerHTML = vis
      .map((s, i) => `<option value="${esc(s.id)}">${i + 1}: ${esc(s.name)}${s.running ? ' ●' : ''}</option>`)
      .join('') || '<option value="">no terminal</option>'
    if (this.activeId) this.select.value = this.activeId
  }

  shortCwd(cwd) {
    if (!cwd) return ''
    let p = cwd === this.home ? '~' : cwd.startsWith(this.home + '/') ? '~' + cwd.slice(this.home.length) : cwd
    if (p.length > 28) p = '…/' + p.split('/').slice(-2).join('/')
    return p
  }

  updatePrompt() {
    const s = this.active
    if (!s) {
      this.prompt.textContent = '$'
      this.input.placeholder = 'Press Enter to start a terminal'
      return
    }
    this.prompt.innerHTML = s.running
      ? `<span class="stdin">stdin ›</span>`
      : `<span class="cwd">${esc(this.shortCwd(s.cwd))}</span> $`
    this.prompt.title = s.cwd
    this.input.placeholder = s.running ? 'Input for the running process (Ctrl+C interrupt, Ctrl+D EOF)' : ''
  }

  atBottom(s) {
    return s.out.scrollHeight - s.out.scrollTop - s.out.clientHeight < 30
  }

  autosize() {
    this.input.style.height = 'auto'
    this.input.style.height = Math.min(this.input.scrollHeight, 120) + 'px'
  }

  focus() {
    this.input.focus({ preventScroll: true })
  }

  cols() {
    const s = this.active
    const w = s?.out?.clientWidth || 600
    const cw = parseFloat(getComputedStyle(this.input).fontSize) * 0.6 || 7
    return Math.max(20, Math.floor((w - 12) / cw))
  }

  local(s, text) {
    if (!s.writer) return
    s.writer.write(text)
    s.out.scrollTop = s.out.scrollHeight
  }

  async submit() {
    let s = this.active
    if (!s) s = await this.create()
    const raw = this.input.value
    this.input.value = ''
    this.autosize()
    if (s.running) {
      await post('/api/term/input', { id: s.id, data: raw + '\n' }).catch(e => notify(e.message, 'error'))
      return
    }
    const cmd = raw.trim()
    this.histIdx = -1
    if (!cmd) {
      this.local(s, `\x1b[1;34m${this.shortCwd(s.cwd)}\x1b[0m \x1b[2m$\x1b[0m\n`)
      return
    }
    if (this.history[this.history.length - 1] !== cmd) {
      this.history.push(cmd)
      if (this.history.length > 500) this.history.splice(0, this.history.length - 500)
    }
    if (await this.builtin(s, cmd)) return
    await this.exec(s.id, REPL[cmd] || cmd)
  }

  async builtin(s, cmd) {
    const [word, ...args] = cmd.split(/\s+/)
    if (word === 'clear' || word === 'cls' || word === 'reset') {
      this.clear()
      return true
    }
    if (word === 'exit' || word === 'logout') {
      this.kill(s)
      return true
    }
    if ((word === 'code' || word === 'edit') && args.length) {
      const home = this.home
      for (const a of args) {
        let p = a.replace(/^~(?=\/|$)/, home)
        if (!p.startsWith('/')) p = s.cwd + '/' + p
        const parts = []
        for (const seg of p.split('/')) {
          if (seg === '..') parts.pop()
          else if (seg && seg !== '.') parts.push(seg)
        }
        this.onOpenPath?.('/' + parts.join('/'))
      }
      return true
    }
    if (NEEDS_TTY.has(word)) {
      this.local(s, `\x1b[1;34m${this.shortCwd(s.cwd)}\x1b[0m \x1b[2m$\x1b[0m ${cmd}\n` +
        `\x1b[33m${word} needs a full-screen terminal (TTY), which a browser panel cannot provide.\x1b[0m\n` +
        `\x1b[2mUse the NEXUS editor, or run it in the Termux app. Prefix with 'command ' to force.\x1b[0m\n`)
      return true
    }
    return false
  }

  async exec(id, command) {
    try {
      await post('/api/term/exec', { id, command, cols: this.cols() })
    } catch (e) {
      notify(e.message, 'error')
    }
  }

  subscribe(id, listener) {
    const s = this.sessions.get(id)
    s?.listeners.add(listener)
    return () => s?.listeners.delete(listener)
  }

  async interrupt(s = this.active) {
    if (s?.running) await post('/api/term/signal', { id: s.id, signal: 'SIGINT' }).catch(() => {})
  }

  async signal(s, signal) {
    if (s?.running) await post('/api/term/signal', { id: s.id, signal }).catch(() => {})
  }

  clear() {
    const s = this.active
    if (!s?.writer) return
    s.writer.clear()
  }

  async kill(s = this.active) {
    if (!s) return
    await post('/api/term/close', { id: s.id }).catch(e => notify(e.message, 'error'))
    this.drop(s.id)
  }

  next(dir) {
    const vis = this.visibleSessions()
    if (vis.length < 2) return
    const i = vis.findIndex(s => s.id === this.activeId)
    this.activate(vis[(i + dir + vis.length) % vis.length].id)
  }

  async complete() {
    const s = this.active
    if (!s || s.running) return
    const caret = this.input.selectionStart
    const line = this.input.value.slice(0, caret)
    let res
    try {
      res = await post('/api/term/complete', { id: s.id, line })
    } catch {
      return
    }
    const { word, items } = res
    if (!items.length) return
    let insert
    if (items.length === 1) insert = items[0] + (items[0].endsWith('/') ? '' : ' ')
    else {
      let pre = items[0]
      for (const it of items) while (!it.startsWith(pre)) pre = pre.slice(0, -1)
      if (pre.length > word.length) insert = pre
      else {
        const shown = items.slice(0, 120)
        this.local(s, `\x1b[2m${shown.join('  ')}${items.length > shown.length ? '  …' : ''}\x1b[0m\n`)
        return
      }
    }
    const v = this.input.value
    this.input.value = v.slice(0, caret - word.length) + insert + v.slice(caret)
    const pos = caret - word.length + insert.length
    this.input.setSelectionRange(pos, pos)
  }

  onKey(e) {
    const s = this.active
    const k = e.key
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey
    const input = this.input
    let handled = true
    if (k === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) this.submit()
    else if (k === 'Tab' && !e.ctrlKey && !e.altKey && !e.shiftKey) this.complete()
    else if (ctrl && k === 'c' && input.selectionStart === input.selectionEnd && !String(getSelection())) {
      if (s?.running) this.interrupt()
      else if (input.value) {
        if (s) this.local(s, `\x1b[1;34m${this.shortCwd(s.cwd)}\x1b[0m \x1b[2m$\x1b[0m ${input.value}^C\n`)
        input.value = ''
        this.autosize()
      }
    } else if (ctrl && k === 'd' && s?.running) post('/api/term/eof', { id: s.id }).catch(() => {})
    else if (ctrl && k === 'l') this.clear()
    else if (ctrl && k === 'u') {
      input.value = input.value.slice(input.selectionStart)
      input.setSelectionRange(0, 0)
    } else if (ctrl && k === 'k') input.value = input.value.slice(0, input.selectionStart)
    else if (ctrl && k === 'a') input.setSelectionRange(0, 0)
    else if (ctrl && k === 'e') input.setSelectionRange(input.value.length, input.value.length)
    else if ((k === 'ArrowUp' || k === 'ArrowDown') && !s?.running && !input.value.includes('\n')) this.historyStep(k === 'ArrowUp' ? -1 : 1)
    else if ((k === 'PageUp' || k === 'PageDown') && s?.out) s.out.scrollTop += (k === 'PageUp' ? -1 : 1) * s.out.clientHeight * 0.9
    else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  historyStep(dir) {
    const h = this.history
    if (!h.length) return
    if (this.histIdx === -1) {
      if (dir > 0) return
      this.draft = this.input.value
      this.histIdx = h.length
    }
    this.histIdx += dir
    if (this.histIdx >= h.length) {
      this.histIdx = -1
      this.input.value = this.draft
    } else {
      this.histIdx = Math.max(0, this.histIdx)
      this.input.value = h[this.histIdx]
    }
    const n = this.input.value.length
    this.input.setSelectionRange(n, n)
    this.autosize()
  }

  anyRunning() {
    return [...this.sessions.values()].some(s => s.running)
  }
}
