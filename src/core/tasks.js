import { stripAnsi } from './ansi.js'
import { notify, confirm } from '../ui/dialog.js'
import { dirname, basename } from '../ui/dom.js'

export const TASKS_FILE = '.nexus.json'

// Binaries go to $TMPDIR because Android mounts shared storage noexec. Without a TTY, C stdio
// fully buffers stdout, so prompts would not appear before input; stdbuf disables that.
const OUT = '"${TMPDIR:-/tmp}/nexus-build"'
const EXEC = `if command -v stdbuf >/dev/null 2>&1; then stdbuf -o0 -e0 ${OUT}/{stem}; else ${OUT}/{stem}; fi`
const CC = `mkdir -p ${OUT} && cc -std=c11 -Wall -Wextra -g -fdiagnostics-color=always {file} -o ${OUT}/{stem} -lm`
const CXX = `mkdir -p ${OUT} && c++ -std=c++17 -Wall -Wextra -g -fdiagnostics-color=always {file} -o ${OUT}/{stem}`
const RUNNERS = {
  c: { build: CC, run: `${CC} && ${EXEC}` },
  cpp: { build: CXX, run: `${CXX} && ${EXEC}` },
  python: { build: 'python3 -m py_compile {file}', run: 'python3 {file}' },
  javascript: { build: 'node --check {file}', run: 'node {file}' },
  shell: { build: 'bash -n {file}', run: 'bash {file}' },
}

const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'"

function normalize(p) {
  const parts = []
  for (const seg of p.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return '/' + parts.join('/')
}

// Converts compiler/interpreter output into problems with project-relative paths.
export function parseProblems(text, cwd, root) {
  const out = []
  const seen = new Set()
  const push = (file, line, col, severity, message, source) => {
    const abs = normalize(file.startsWith('/') ? file : cwd + '/' + file)
    if (!abs.startsWith(root + '/')) return
    const path = abs.slice(root.length + 1)
    const key = [path, line, col, message].join('|')
    if (seen.has(key)) return
    seen.add(key)
    out.push({ path, line: +line || 1, col: col ? +col : 1, severity, message, source })
  }
  let pyLoc = null
  let jsLoc = null
  let jsErr = null
  for (const raw of stripAnsi(text).split('\n')) {
    const line = raw.replace(/\r$/, '')
    let m
    if ((m = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/.exec(line))) {
      const sev = m[4] === 'warning' ? 'warning' : m[4] === 'note' ? 'info' : 'error'
      push(m[1], m[2], m[3], sev, m[5], 'cc')
    } else if ((m = /^\s*File "(.+?)", line (\d+)/.exec(line))) {
      pyLoc = { file: m[1], line: m[2] }
    } else if (pyLoc && (m = /^(\w+(?:Error|Exception|Warning|Exit))\b(?::\s*(.*))?$/.exec(line))) {
      push(pyLoc.file, pyLoc.line, null, 'error', line, 'python')
      pyLoc = null
    } else if ((m = /^(.+?): line (\d+): (.*)$/.exec(line))) {
      push(m[1], m[2], null, 'error', m[3], 'sh')
    } else if ((m = /^(\/.+?\.[cm]?[jt]sx?):(\d+)$/.exec(line))) {
      jsLoc = { file: m[1], line: m[2] }
    } else if ((m = /^(?:Uncaught )?(\w*Error)(?::\s*(.*))?$/.exec(line))) {
      if (jsLoc) {
        push(jsLoc.file, jsLoc.line, null, 'error', line, 'node')
        jsLoc = null
      } else jsErr = line
    } else if (jsErr && (m = /^\s+at (?:.*? \()?(?:file:\/\/)?(\/[^:()]+):(\d+):(\d+)\)?$/.exec(line))) {
      if (normalize(m[1]).startsWith(root + '/')) {
        push(m[1], m[2], m[3], 'error', jsErr, 'node')
        jsErr = null
      }
    }
  }
  return out
}

export class Tasks {
  constructor({ terminal, output, problems, fm, getRoot, getActive, showPanel, saveAll }) {
    Object.assign(this, { terminal, output, problems, fm, getRoot, getActive, showPanel, saveAll })
    this.buildSession = null
  }

  async config() {
    try {
      const data = await this.fm.read(TASKS_FILE)
      return JSON.parse(data.content)
    } catch (e) {
      if (e instanceof SyntaxError) notify(`${TASKS_FILE} is not valid JSON: ${e.message}`, 'error')
      return null
    }
  }

  vars(doc) {
    const root = this.getRoot()
    const rel = doc && !doc.virtual ? doc.path : ''
    const abs = rel ? root + '/' + rel : ''
    const name = basename(rel)
    return {
      root: quote(root),
      file: quote(abs),
      relFile: quote(rel),
      dir: quote(rel ? root + '/' + dirname(rel) : root).replace(/\/'$/, "'"),
      stem: quote(name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name || 'a.out'),
    }
  }

  // Returns { command, cwd } for 'build' or 'run', or null with a notification.
  async resolve(kind) {
    const doc = this.getActive()
    const root = this.getRoot()
    const vars = this.vars(doc)
    const subst = cmd => cmd.replace(/\{(root|file|relFile|dir|stem)\}/g, (_, k) => vars[k])
    const cfg = await this.config()
    if (cfg && typeof cfg[kind] === 'string') return { command: subst(cfg[kind]), cwd: root }
    const runner = doc && RUNNERS[doc.lang]
    if (runner) {
      const cwd = root + (dirname(doc.path) ? '/' + dirname(doc.path) : '')
      return { command: subst(runner[kind]), cwd }
    }
    let files = []
    try {
      files = (await this.fm.listFiles()).files
    } catch {}
    if (files.includes('Makefile') || files.includes('makefile')) return { command: kind === 'build' ? 'make' : 'make && make run', cwd: root }
    if (files.includes('package.json')) {
      try {
        const pkg = JSON.parse((await this.fm.read('package.json')).content)
        const s = pkg.scripts || {}
        if (kind === 'build' && s.build) return { command: 'npm run build', cwd: root }
        if (kind === 'run' && (s.start || s.dev)) return { command: s.start ? 'npm start' : 'npm run dev', cwd: root }
      } catch {}
    }
    notify(`Nothing to ${kind}. Open a C, C++, Python, JavaScript or shell file, or run "Run: Configure Tasks".`, 'warn')
    return null
  }

  async ensureBuildSession() {
    const existing = this.buildSession && this.terminal.sessions.get(this.buildSession.id)
    if (existing) return existing
    this.buildSession = await this.terminal.create({ name: 'task', hidden: true, focus: false })
    return this.buildSession
  }

  async build() {
    const task = await this.resolve('build')
    if (!task) return
    await this.saveAll()
    const s = await this.ensureBuildSession()
    if (s.running) return notify('A build is already running (Shift+F5 to stop)', 'warn')
    this.showPanel('output')
    this.output.log('Build: ' + task.command)
    let buf = ''
    const unsub = this.terminal.subscribe(s.id, {
      onData: d => {
        buf += d
        this.output.write(d)
      },
      onExit: info => {
        unsub()
        const problems = parseProblems(buf, task.cwd, this.getRoot())
        this.problems.setTask(problems)
        const errs = problems.filter(p => p.severity === 'error').length
        const ok = info.code === 0
        this.output.log(ok ? `Build succeeded${problems.length ? ` with ${problems.length} warning(s)` : ''}` : `Build failed (exit ${info.code ?? info.signal}), ${errs} error(s)`, ok ? 'info' : 'error')
        if (!ok) notify(`Build failed: ${errs} error(s). F8 jumps to the next problem.`, 'error')
      },
    })
    await this.terminal.exec(s.id, `cd ${quote(task.cwd)} && ${task.command}`)
  }

  async run() {
    const task = await this.resolve('run')
    if (!task) return
    await this.saveAll()
    let s = this.terminal.visibleSessions().find(x => x.name === 'run')
    if (s?.running) {
      const choice = await confirm({ title: 'The previous run is still active', message: 'Stop it and run again?', buttons: ['Restart', 'Cancel'] })
      if (choice !== 0) return
      await this.stopSession(s)
    }
    if (!s) s = await this.terminal.create({ name: 'run', focus: false })
    this.showPanel('terminal')
    this.terminal.activate(s.id, true)
    let buf = ''
    const unsub = this.terminal.subscribe(s.id, {
      onData: d => {
        if (buf.length < 512 * 1024) buf += d
      },
      onExit: () => {
        unsub()
        this.problems.setTask(parseProblems(buf, task.cwd, this.getRoot()))
      },
    })
    await this.terminal.exec(s.id, `cd ${quote(task.cwd)} && ${task.command}`)
  }

  stopSession(s) {
    return new Promise(resolve => {
      if (!s.running) return resolve()
      const unsub = this.terminal.subscribe(s.id, { onExit: () => (unsub(), clearTimeout(t), resolve()) })
      this.terminal.signal(s, 'SIGINT')
      const t = setTimeout(() => {
        this.terminal.signal(s, 'SIGKILL')
        setTimeout(resolve, 300)
      }, 1500)
    })
  }

  async stop() {
    const targets = [this.buildSession && this.terminal.sessions.get(this.buildSession.id), this.terminal.visibleSessions().find(x => x.name === 'run')]
    let any = false
    for (const s of targets) {
      if (s?.running) {
        any = true
        await this.stopSession(s)
      }
    }
    if (!any) notify('No build or run in progress')
  }

  template() {
    const doc = this.getActive()
    const r = (doc && RUNNERS[doc.lang]) || { build: 'make', run: 'make && ./app' }
    return JSON.stringify({
      build: r.build,
      run: r.run,
      _help: 'Commands run with bash from the project root. Placeholders: {file} {relFile} {dir} {stem} {root}',
    }, null, 2) + '\n'
  }
}
