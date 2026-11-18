import { AnsiWriter } from '../core/ansi.js'
import { el, iconButton } from '../ui/dom.js'

export class OutputPanel {
  constructor() {
    this.el = el('div', 'output', { tabindex: '0', role: 'log', 'aria-label': 'Output' })
    this.writer = new AnsiWriter(this.el, 5000)
    this.tools = el('div', 'tools')
    this.tools.append(iconButton('clear', 'Clear Output', () => this.clear()))
  }

  write(text) {
    const stick = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 30
    this.writer.write(text)
    if (stick) this.el.scrollTop = this.el.scrollHeight
  }

  log(message, type = 'info') {
    const t = new Date().toTimeString().slice(0, 8)
    const color = type === 'error' ? '\x1b[31m' : type === 'warn' ? '\x1b[33m' : ''
    this.write(`\x1b[2m[${t}]\x1b[0m ${color}${message}\x1b[0m\n`)
  }

  clear() {
    this.writer.clear()
  }

  focus() {
    this.el.focus({ preventScroll: true })
  }
}
