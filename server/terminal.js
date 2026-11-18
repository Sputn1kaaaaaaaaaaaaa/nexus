import { spawn, execFile } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_SESSIONS = 8
const SCROLLBACK = 96 * 1024
const FLUSH_MS = 24

// Every command runs in a fresh bash process group. Exported variables, aliases and
// functions are carried between commands through a per-session state file, and the
// final working directory is written back so the session can follow `cd`.
const SCRIPT = `
__nx_cmd=$NEXUS_CMD; __nx_state=$NEXUS_STATE; __nx_cwdf=$NEXUS_CWDFILE
unset NEXUS_CMD NEXUS_STATE NEXUS_CWDFILE
[ -f "$__nx_state" ] && . "$__nx_state" 2>/dev/null
shopt -s expand_aliases
eval "$__nx_cmd"
__nx_rc=$?
{ export -p; alias -p; declare -f; } > "$__nx_state" 2>/dev/null
pwd > "$__nx_cwdf"
exit $__nx_rc
`

const shortPath = p => {
  const home = os.homedir()
  return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export class TerminalManager extends EventEmitter {
  constructor({ stateDir, shell, fallbackCwd }) {
    super()
    this.stateDir = stateDir
    this.shell = shell
    this.fallbackCwd = fallbackCwd
    this.sessions = new Map()
    this.seq = 0
    this.paused = false
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  }

  info(s) {
    return { id: s.id, name: s.name, hidden: s.hidden, cwd: s.cwd, running: !!s.proc, command: s.command }
  }

  list() {
    return [...this.sessions.values()].map(s => this.info(s))
  }

  get(id) {
    const s = this.sessions.get(id)
    if (!s) throw Object.assign(new Error('No such terminal session'), { status: 404 })
    return s
  }

  create({ cwd, name, hidden }) {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw Object.assign(new Error(`Session limit reached (${MAX_SESSIONS})`), { status: 429 })
    }
    const id = 't' + ++this.seq + '-' + Date.now().toString(36)
    const s = {
      id,
      name: String(name || 'bash').slice(0, 32),
      hidden: !!hidden,
      cwd,
      proc: null,
      command: '',
      groups: new Set(),
      scrollback: '',
      pending: '',
      timer: null,
      stateFile: path.join(this.stateDir, id + '.env'),
      cwdFile: path.join(this.stateDir, id + '.cwd'),
    }
    this.sessions.set(id, s)
    this.emit('created', this.info(s))
    return this.info(s)
  }

  write(s, text) {
    if (!text) return
    s.pending += text
    s.scrollback += text
    if (s.scrollback.length > SCROLLBACK) {
      const cut = s.scrollback.indexOf('\n', s.scrollback.length - SCROLLBACK)
      s.scrollback = s.scrollback.slice(cut + 1)
    }
    if (!s.timer) s.timer = setTimeout(() => this.flush(s), FLUSH_MS)
  }

  flush(s) {
    clearTimeout(s.timer)
    s.timer = null
    if (!s.pending) return
    const data = s.pending
    s.pending = ''
    this.emit('data', { id: s.id, data })
  }

  exec(id, command, cols = 80) {
    const s = this.get(id)
    if (s.proc) throw Object.assign(new Error('A command is already running in this session'), { status: 409 })
    command = String(command)
    const cwd = isDir(s.cwd) ? s.cwd : this.fallbackCwd()
    s.cwd = cwd
    this.write(s, `\x1b[1;34m${shortPath(cwd)}\x1b[0m \x1b[2m$\x1b[0m ${command}\n`)
    const env = {
      ...process.env,
      TERM: 'dumb',
      COLUMNS: String(Math.max(20, Math.min(400, cols | 0 || 80))),
      LINES: '40',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      MANPAGER: 'cat',
      PYTHONUNBUFFERED: '1',
      NEXUS: '1',
      NEXUS_CMD: command,
      NEXUS_STATE: s.stateFile,
      NEXUS_CWDFILE: s.cwdFile,
    }
    delete env.NEXUS_TOKEN
    let proc
    try {
      proc = spawn(this.shell, ['-c', SCRIPT], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      this.write(s, `\x1b[31mnexus: failed to start shell: ${e.message}\x1b[0m\n`)
      return this.info(s)
    }
    const started = Date.now()
    const out = new StringDecoder('utf8')
    const err = new StringDecoder('utf8')
    s.proc = proc
    s.command = command
    if (proc.pid) s.groups.add(proc.pid)
    proc.stdout.on('data', b => this.write(s, out.write(b)))
    proc.stderr.on('data', b => this.write(s, err.write(b)))
    proc.stdin.on('error', () => {})
    if (this.paused) {
      proc.stdout.pause()
      proc.stderr.pause()
    }
    let done = false
    const finish = (code, signal) => {
      if (done) return
      done = true
      let cwdNow = s.cwd
      try {
        const c = fs.readFileSync(s.cwdFile, 'utf8').trim()
        if (c && isDir(c)) cwdNow = c
      } catch {}
      s.cwd = cwdNow
      const secs = (Date.now() - started) / 1000
      const notes = []
      if (signal) notes.push(signal)
      else if (code) notes.push('exit ' + code)
      if (secs >= 3) notes.push(secs.toFixed(1) + 's')
      if (notes.length) this.write(s, `\x1b[2m[${notes.join(', ')}]\x1b[0m\n`)
      s.proc = null
      s.command = ''
      this.flush(s)
      this.emit('exit', { id: s.id, code, signal, cwd: s.cwd })
    }
    proc.on('error', e => {
      this.write(s, `\x1b[31mnexus: ${e.message}\x1b[0m\n`)
      finish(127, null)
    })
    // `exit` fires when bash ends; give buffered output a moment to arrive before the footer.
    proc.on('exit', (code, signal) => {
      const t = setTimeout(() => finish(code, signal), 150)
      proc.once('close', () => {
        clearTimeout(t)
        finish(code, signal)
      })
    })
    this.emit('start', { id: s.id, command })
    return this.info(s)
  }

  input(id, data) {
    const s = this.get(id)
    if (!s.proc) throw Object.assign(new Error('No running process'), { status: 409 })
    data = String(data)
    this.write(s, `\x1b[2m${data}\x1b[0m`)
    s.proc.stdin.write(data)
  }

  eof(id) {
    const s = this.get(id)
    if (s.proc) s.proc.stdin.end()
  }

  signal(id, sig) {
    const s = this.get(id)
    if (!['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGQUIT'].includes(sig)) {
      throw Object.assign(new Error('Unsupported signal'), { status: 400 })
    }
    if (!s.proc) return
    if (sig === 'SIGINT') this.write(s, '\x1b[2m^C\x1b[0m\n')
    try {
      process.kill(-s.proc.pid, sig)
    } catch {
      s.proc.kill(sig)
    }
  }

  killGroups(s, sig) {
    for (const pid of s.groups) {
      try {
        process.kill(-pid, sig)
      } catch {
        s.groups.delete(pid)
      }
    }
  }

  close(id) {
    const s = this.get(id)
    this.killGroups(s, 'SIGTERM')
    const groups = new Set(s.groups)
    setTimeout(() => this.killGroups({ groups }, 'SIGKILL'), 1500).unref()
    clearTimeout(s.timer)
    fs.rm(s.stateFile, { force: true }, () => {})
    fs.rm(s.cwdFile, { force: true }, () => {})
    this.sessions.delete(id)
    this.emit('closed', { id })
  }

  closeAll() {
    for (const s of this.sessions.values()) this.killGroups(s, 'SIGKILL')
  }

  setPaused(paused) {
    if (this.paused === paused) return
    this.paused = paused
    for (const s of this.sessions.values()) {
      if (!s.proc) continue
      for (const st of [s.proc.stdout, s.proc.stderr]) paused ? st.pause() : st.resume()
    }
  }

  complete(id, line) {
    const s = this.get(id)
    const word = /[^\s;|&<>()]*$/.exec(line)[0]
    const before = line.slice(0, line.length - word.length)
    const isCmd = /^\s*$|[;|&(]\s*$/.test(before) && !word.includes('/')
    const gen = isCmd ? 'compgen -A function -abck -- "$1"' : 'compgen -f -- "$1"'
    const script = `[ -f "$2" ] && . "$2" 2>/dev/null; ${gen} 2>/dev/null | sort -u | head -n 300`
    const cwd = isDir(s.cwd) ? s.cwd : this.fallbackCwd()
    return new Promise(resolve => {
      execFile(this.shell, ['-c', script, 'nexus', word, s.stateFile], { cwd, timeout: 3000 }, (_, stdout) => {
        const items = String(stdout || '').split('\n').filter(Boolean).map(item => {
          if (isCmd) return item
          const abs = path.resolve(cwd, item.replace(/^~(?=\/|$)/, os.homedir()))
          return isDir(abs) ? item + '/' : item
        })
        resolve({ word, items })
      })
    })
  }
}
