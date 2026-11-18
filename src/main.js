import './style.css'
import { get, post, put } from './core/api.js'
import * as keyboard from './core/keyboard.js'
import * as commands from './core/commands.js'
import { configure as configureEditor, config as editorConfig } from './core/editor.js'
import { FileManager, SETTINGS_PATH } from './core/fileManager.js'
import { Tabs } from './core/tabs.js'
import { FindWidget } from './core/find.js'
import { Layout } from './core/layout.js'
import { Tasks, TASKS_FILE } from './core/tasks.js'
import { langInfo, languageIds } from './core/syntax.js'
import { Explorer } from './panels/explorer.js'
import { SearchView } from './panels/search.js'
import { TerminalPanel } from './panels/terminal.js'
import { ProblemsPanel } from './panels/problems.js'
import { OutputPanel } from './panels/output.js'
import { quickPick, fuzzy, fuzzyPath } from './ui/quickpick.js'
import { prompt, confirm, notify, onNotify, dismissToasts } from './ui/dialog.js'
import { showMenu } from './ui/menu.js'
import { el, esc, debounce, basename, dirname, iconButton } from './ui/dom.js'

const DEFAULT_SETTINGS = {
  'editor.fontSize': 13,
  'editor.tabSize': 4,
  'editor.insertSpaces': true,
  'editor.detectIndentation': true,
  'editor.autoClosingBrackets': true,
  'editor.autocomplete': true,
  'files.autoSave': 'off',
  'files.exclude': ['.git'],
  'search.exclude': ['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', '.next', 'dist', 'build'],
  'terminal.fontSize': 12,
  keybindings: {},
}

let settings = { ...DEFAULT_SETTINGS }
let info
let layout, fm, tabs, find, explorer, search, terminal, problems, output, tasks
let recentFiles = []
let termHistory = []
let zoom = null
const app = document.getElementById('app')

// ---------- boot ----------

async function authenticate() {
  const url = new URL(location.href)
  const token = url.searchParams.get('token')
  if (token) {
    await post('/api/auth', { token }).catch(() => {})
    url.searchParams.delete('token')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  }
  try {
    return await get('/api/info')
  } catch (e) {
    if (e.status === 401) return null
    throw e
  }
}

function showAuthScreen() {
  app.className = 'auth'
  app.innerHTML = `<form class="auth-box">
    <div class="brand">NEXUS</div>
    <p>This session is not authorized. Open the URL printed by the NEXUS server in Termux,
    or paste the token from <code>~/.nexus/token</code>.</p>
    <input name="token" type="password" placeholder="Access token" autocomplete="off" autofocus>
    <button class="btn primary" type="submit">Connect</button>
    <div class="auth-err"></div></form>`
  app.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault()
    try {
      await post('/api/auth', { token: e.target.token.value.trim() })
      location.reload()
    } catch (err) {
      app.querySelector('.auth-err').textContent = err.message
    }
  })
}

async function boot() {
  try {
    info = await authenticate()
  } catch (e) {
    app.className = 'auth'
    app.innerHTML = `<div class="auth-box"><div class="brand">NEXUS</div><p>${esc(e.message)}. Is the server running?</p></div>`
    return
  }
  if (!info) return showAuthScreen()

  const [settingsData, ws] = await Promise.all([get('/api/settings'), get('/api/state').catch(() => ({}))])
  applySettings(settingsData.mtime == null ? '{}' : settingsData.content, true)
  if (ws.zoom) {
    zoom = ws.zoom
    configureEditor({ fontSize: zoom })
  }
  buildUI()
  registerCommands()
  buildMenus()
  keyboard.init({ run: id => commands.execute(id), context })
  await restore(ws || {})
  terminal.connect()
  app.classList.remove('booting')
  addEventListener('focus', onFocusBack)
  addEventListener('beforeunload', e => {
    saveState.flush()
    if (fm.dirtyDocs().length) e.preventDefault()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveState.flush()
  })
}

function applySettings(text, initial = false) {
  let user
  try {
    user = JSON.parse(text || '{}')
  } catch (e) {
    if (!initial) notify('settings.json is invalid: ' + e.message, 'error')
    return
  }
  settings = { ...DEFAULT_SETTINGS, ...user }
  configureEditor({
    fontSize: zoom || +settings['editor.fontSize'] || 13,
    tabSize: +settings['editor.tabSize'] || 4,
    insertSpaces: settings['editor.insertSpaces'] !== false,
    detectIndent: settings['editor.detectIndentation'] !== false,
    autoClose: settings['editor.autoClosingBrackets'] !== false,
    autocomplete: settings['editor.autocomplete'] !== false,
  })
  document.documentElement.style.setProperty('--term-fs', (+settings['terminal.fontSize'] || 12) + 'px')
  keyboard.setOverrides(settings.keybindings)
  if (!initial) {
    buildMenus()
    renderWelcome()
    fm?.invalidate()
    explorer?.refresh()
  }
}

// ---------- UI ----------

function buildUI() {
  document.getElementById('project-name').textContent = info.name
  document.getElementById('project-name').title = info.root + ' (click to open another project)'
  document.getElementById('project-name').addEventListener('click', () => commands.execute('file.openProject'))
  document.title = info.name + ' - NEXUS'

  layout = new Layout({ app, onChange: () => saveState(), focusEditor })

  fm = new FileManager({
    onDirty: doc => {
      tabs.render()
      if (doc === tabs.active) updateStatus()
      saveState()
    },
    onChange: doc => {
      if (doc === tabs.active) find.refresh()
      saveState()
      if (settings['files.autoSave'] === 'afterDelay' && !doc.virtual) autoSave()
    },
    onSaved: doc => {
      if (doc.path === SETTINGS_PATH) applySettings(doc.view.text)
      if (doc === tabs.active) updateStatus()
    },
    onRenamed: (doc, old) => {
      tabs.render()
      problems.renameEditor(old, doc.path)
      if (doc === tabs.active) updateStatus()
    },
    onCursor: doc => {
      if (doc === tabs.active) updateCursor()
      saveState()
    },
    onDiagnostics: doc => problems.setEditor(doc.path, doc.diagnostics),
    extraDiagnostics: doc => problems.forPath(doc.path),
    defaultSettings: () => JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n',
  })

  tabs = new Tabs({
    bar: document.getElementById('tabbar'),
    container: document.getElementById('editors'),
    fm,
    onActivate: doc => {
      document.getElementById('welcome').style.display = 'none'
      if (!doc.virtual) explorer.reveal(doc.path)
      find.refresh()
      updateStatus()
      saveState()
    },
    onEmpty: () => {
      document.getElementById('welcome').style.display = ''
      explorer.activePath = null
      explorer.render()
      find.close()
      updateStatus()
      renderWelcome()
      saveState()
    },
  })

  find = new FindWidget(document.getElementById('editor-area'), () => tabs.active?.view)

  explorer = new Explorer({
    open: (path, { focus }) => openFile(path, { focus }),
    newFile: dir => newFile(dir),
    newFolder: dir => newFolder(dir),
    rename: path => renamePath(path),
    remove: path => deletePath(path),
    copyPath: (path, abs) => copyText(abs ? info.root + (path ? '/' + path : '') : path || '.'),
    terminalHere: dir => openTerminalAt(dir),
  })
  explorer.setRootName(info.name)
  search = new SearchView({
    onOpen: (path, line, col, len, focus) => openFile(path, { line, col, len, focus }),
  })
  layout.addSideView('explorer', 'Explorer', explorer)
  layout.addSideView('search', 'Search', search)

  output = new OutputPanel()
  onNotify((msg, type) => output.log(msg, type))
  problems = new ProblemsPanel({
    onOpen: (path, line, col) => openFile(path, { line, col }),
    onChange: counts => {
      layout.setBadge('problems', counts.errors + counts.warnings || '')
      updateProblemsStatus(counts)
      for (const doc of fm.docs.values()) doc.view.setDiagnostics(doc.diagnostics.concat(problems.forPath(doc.path)))
    },
  })
  terminal = new TerminalPanel({
    home: info.home,
    getRoot: () => info.root,
    history: termHistory,
    onExit: () => refreshAfterCommand(),
    onOpenPath: openAbsolute,
    onRunningChange: updateRunning,
  })
  layout.addPanelView('terminal', 'Terminal', {
    el: terminal.el,
    tools: terminal.tools,
    focus: async () => {
      await terminal.ensureSession()
      terminal.focus()
    },
  })
  layout.addPanelView('output', 'Output', output)
  layout.addPanelView('problems', 'Problems', problems)

  tasks = new Tasks({
    terminal, output, problems, fm,
    getRoot: () => info.root,
    getActive: () => tabs.active,
    showPanel: id => layout.showPanel(id),
    saveAll: () => saveAll(true),
  })

  const actions = document.getElementById('title-actions')
  actions.append(
    iconButton('sidebar', 'Toggle Explorer (Ctrl+B)', () => commands.execute('view.toggleExplorer')),
    iconButton('search', 'Search Project (Ctrl+Shift+F)', () => commands.execute('view.showSearch')),
    iconButton('panel', 'Toggle Panel (Ctrl+J)', () => commands.execute('view.togglePanel')),
    iconButton('build', 'Build (Ctrl+Shift+B)', () => commands.execute('run.build')),
    iconButton('play', 'Run (F5)', () => commands.execute('run.run')),
  )
  buildStatusBar()
}

function context() {
  const a = document.activeElement
  return {
    modal: !!document.querySelector('.modal'),
    editorFocus: !!a && a.classList?.contains('ed-input'),
    terminalFocus: a === terminal.input,
    inputFocus: !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'),
  }
}

function focusEditor() {
  if (tabs.active) tabs.active.view.focus()
  else document.getElementById('welcome').focus()
}

// ---------- status bar ----------

const sb = {}
function buildStatusBar() {
  const bar = document.getElementById('statusbar')
  const item = (cls, title, onclick) => {
    const n = el(onclick ? 'button' : 'span', 'sb-item ' + cls, { title, type: onclick ? 'button' : null })
    if (onclick) n.addEventListener('click', onclick)
    return n
  }
  sb.problems = item('sb-problems', 'Problems (Ctrl+Shift+M)', () => commands.execute('view.showProblems'))
  sb.running = item('sb-running', 'Running processes')
  sb.conn = item('sb-conn', 'Server connection')
  sb.state = item('sb-state', 'File status')
  sb.pos = item('sb-pos', 'Go to Line (Ctrl+G)', () => commands.execute('go.line'))
  sb.indent = item('sb-indent sb-wide', 'Select Indentation', () => commands.execute('editor.indentation'))
  sb.enc = item('sb-enc sb-wide', 'Encoding')
  sb.eol = item('sb-eol sb-wide', 'Toggle Line Endings', () => commands.execute('editor.toggleEol'))
  sb.lang = item('sb-lang', 'Select Language Mode', () => commands.execute('editor.language'))
  const left = el('div', 'sb-left')
  const right = el('div', 'sb-right')
  left.append(sb.problems, sb.running)
  right.append(sb.state, sb.pos, sb.indent, sb.enc, sb.eol, sb.lang, sb.conn)
  bar.append(left, right)
  updateProblemsStatus({ errors: 0, warnings: 0 })
  updateStatus()
  updateRunning()
}

function updateProblemsStatus({ errors, warnings }) {
  if (!sb.problems) return
  sb.problems.innerHTML = `<span class="${errors ? 'err' : ''}">✕ ${errors}</span> <span class="${warnings ? 'warn' : ''}">! ${warnings}</span>`
}

function updateRunning() {
  if (!sb.running) return
  const running = [...terminal.sessions.values()].filter(s => s.running)
  sb.running.textContent = running.length ? `● ${running.map(s => s.name).join(', ')}` : ''
  sb.conn.textContent = terminal.connected ? '' : 'offline'
  sb.conn.classList.toggle('off', !terminal.connected)
}

function updateCursor() {
  const doc = tabs.active
  if (!doc) return
  const c = doc.view.cursor()
  sb.pos.textContent = `Ln ${c.line}, Col ${c.col}${c.selected ? ` (${c.selected} sel)` : ''}`
}

function updateStatus() {
  const doc = tabs?.active
  for (const k of ['state', 'pos', 'indent', 'enc', 'eol', 'lang']) sb[k].style.display = doc ? '' : 'none'
  if (!doc) return
  updateCursor()
  sb.state.textContent = doc.missing ? 'Deleted on disk' : doc.dirty ? '● Modified' : 'Saved'
  sb.state.className = 'sb-item sb-state' + (doc.missing ? ' warn' : doc.dirty ? ' dirty' : '')
  sb.indent.textContent = doc.view.indent.spaces ? `Spaces: ${doc.view.indent.size}` : `Tab: ${doc.view.indent.size}`
  sb.enc.textContent = 'UTF-8'
  sb.eol.textContent = doc.eol === '\r\n' ? 'CRLF' : 'LF'
  sb.lang.textContent = langInfo(doc.lang).name
  document.title = (doc.dirty ? '● ' : '') + doc.name + ' - ' + info.name + ' - NEXUS'
}

// ---------- welcome ----------

function renderWelcome() {
  const w = document.getElementById('welcome')
  if (!w || tabs?.active) return
  const row = (id, label) => `<button class="wl-cmd" data-cmd="${id}"><span>${esc(label)}</span><kbd>${esc(commands.keyHint(id))}</kbd></button>`
  const files = recentFiles.slice(0, 6)
  const projects = (info.recent || []).filter(p => p !== info.root).slice(0, 5)
  w.innerHTML = `<div class="wl">
    <div class="wl-head"><span class="brand">NEXUS</span><span class="wl-path">${esc(info.root)}</span></div>
    <div class="wl-cols">
      <section><h2>Start</h2>
        ${row('file.quickOpen', 'Go to File…')}${row('file.new', 'New File…')}${row('file.openProject', 'Open Project…')}
        ${row('view.palette', 'Command Palette')}${row('view.toggleTerminal', 'Terminal')}${row('run.run', 'Run Active File')}
      </section>
      ${files.length ? `<section><h2>Recent Files</h2>${files.map(f => `<button class="wl-file" data-file="${esc(f)}">${esc(f)}</button>`).join('')}</section>` : ''}
      ${projects.length ? `<section><h2>Recent Projects</h2>${projects.map(p => `<button class="wl-file" data-project="${esc(p)}">${esc(p.replace(info.home, '~'))}</button>`).join('')}</section>` : ''}
    </div></div>`
  for (const b of w.querySelectorAll('[data-cmd]')) b.addEventListener('click', () => commands.execute(b.dataset.cmd))
  for (const b of w.querySelectorAll('[data-file]')) b.addEventListener('click', () => openFile(b.dataset.file))
  for (const b of w.querySelectorAll('[data-project]')) b.addEventListener('click', () => switchProject(b.dataset.project))
}

// ---------- files ----------

async function openFile(path, opts = {}) {
  let doc
  try {
    doc = await fm.load(path)
  } catch (e) {
    notify(`Cannot open ${path}: ${e.message}`, 'error')
    return null
  }
  tabs.activate(doc, { focus: opts.focus !== false })
  if (opts.line) {
    const p = doc.view.posAt(opts.line - 1, (opts.col || 1) - 1)
    doc.view.select(p, p + (opts.len || 0), { center: true })
  }
  if (layout.narrow && layout.s.sidebar && opts.focus !== false) layout.toggleSidebar(false)
  if (!doc.virtual) recentFiles = [path, ...recentFiles.filter(p => p !== path)].slice(0, 30)
  return doc
}

async function openAbsolute(abs) {
  const root = info.root
  if (abs === root || !abs.startsWith(root + '/')) {
    if (info.bases.some(b => abs === b || abs.startsWith(b + '/'))) {
      const c = await confirm({ title: 'Open as project?', message: abs, buttons: ['Open Project', 'Cancel'] })
      if (c === 0) switchProject(abs)
    } else notify('Path is outside the project: ' + abs, 'warn')
    return
  }
  const rel = abs.slice(root.length + 1)
  try {
    await fm.load(rel)
    openFile(rel)
  } catch (e) {
    if (e.status === 404) {
      await fm.create(rel)
      await explorer.refresh()
      openFile(rel)
    } else if (e.status === 400) {
      layout.showSide('explorer')
      await explorer.reveal(rel + '/x')
      explorer.select(explorer.find(rel))
    } else notify(e.message, 'error')
  }
}

async function saveDoc(doc = tabs.active) {
  if (!doc) return
  const isNew = doc.missing
  if (await fm.save(doc)) {
    if (isNew) explorer.refresh()
    if (doc.path === TASKS_FILE) notify('Tasks updated')
  }
}

async function saveAll(quiet = false) {
  const dirty = fm.dirtyDocs()
  for (const d of dirty) await fm.save(d)
  if (!quiet && !dirty.length) notify('Nothing to save')
}

const autoSave = debounce(() => {
  for (const d of fm.dirtyDocs()) if (!d.virtual && !d.missing) fm.save(d)
}, 1000)

function validName(v) {
  if (!v.trim()) return 'A name is required'
  if (v.split('/').some(s => s === '..')) return 'Path cannot contain ..'
  if (/^\//.test(v)) return 'Use a path relative to the project'
  return ''
}

function currentDir() {
  if (layout.region() === 'sidebar' && layout.s.sideView === 'explorer') return explorer.targetDir()
  const doc = tabs.active
  return doc && !doc.virtual ? dirname(doc.path) : ''
}

async function newFile(dir = currentDir()) {
  const prefix = dir ? dir + '/' : ''
  const path = await prompt({ title: 'New file (folders are created as needed)', value: prefix, select: [prefix.length, prefix.length], placeholder: 'src/main.c', validate: validName })
  if (!path) return
  try {
    const p = await fm.create(path.trim(), 'file')
    await explorer.refresh()
    await openFile(p)
  } catch (e) {
    notify(e.message, 'error')
  }
}

async function newFolder(dir = currentDir()) {
  const prefix = dir ? dir + '/' : ''
  const path = await prompt({ title: 'New folder', value: prefix, select: [prefix.length, prefix.length], validate: validName })
  if (!path) return
  try {
    const p = await fm.create(path.trim().replace(/\/+$/, ''), 'dir')
    await explorer.refresh()
    layout.showSide('explorer')
    await explorer.reveal(p + '/x')
    explorer.select(explorer.find(p))
  } catch (e) {
    notify(e.message, 'error')
  }
}

async function renamePath(path) {
  if (!path) return
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  const start = path.length - base.length
  const to = await prompt({ title: 'Rename / move', value: path, select: [start, dot > 0 ? start + dot : path.length], validate: validName })
  if (!to || to === path) return
  try {
    const target = await fm.rename(path, to.trim())
    await explorer.refresh()
    explorer.reveal(target)
  } catch (e) {
    notify(e.message, 'error')
  }
}

async function deletePath(path) {
  if (!path) return
  const affected = [...fm.docs.values()].filter(d => d.path === path || d.path.startsWith(path + '/'))
  const dirty = affected.filter(d => d.dirty).length
  const choice = await confirm({
    title: `Delete ${path}?`,
    message: 'This permanently deletes it from disk.' + (dirty ? `\n${dirty} open file(s) have unsaved changes.` : ''),
    buttons: ['Delete', 'Cancel'],
    danger: true,
  })
  if (choice !== 0) return
  try {
    const docs = await fm.remove(path)
    for (const d of docs) await tabs.close(d, { force: true })
    problems.setEditor(path, [])
    await explorer.refresh()
  } catch (e) {
    notify(e.message, 'error')
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    notify('Copied: ' + text)
  } catch {
    notify('Clipboard is not available', 'warn')
  }
}

async function openTerminalAt(dir) {
  layout.showPanel('terminal')
  await terminal.create({ cwd: dir || '.' })
}

const refreshAfterCommand = debounce(() => {
  fm.invalidate()
  explorer.refresh()
  fm.checkExternal()
}, 400)

let lastFocusCheck = 0
function onFocusBack() {
  if (Date.now() - lastFocusCheck < 2000) return
  lastFocusCheck = Date.now()
  refreshAfterCommand()
}

// ---------- projects ----------

async function switchProject(path) {
  const dirty = fm.dirtyDocs()
  if (dirty.length) {
    const c = await confirm({ title: 'Save changes before switching project?', message: dirty.map(d => d.path).join('\n'), buttons: ['Save All', 'Discard', 'Cancel'] })
    if (c === 2) return
    if (c === 0) await saveAll(true)
    else for (const d of dirty) d.dirty = false
  }
  saveState.flush()
  try {
    await post('/api/project', { path })
    location.reload()
  } catch (e) {
    notify(e.message, 'error')
  }
}

function openProjectPicker() {
  let cur = info.root
  let listing = null
  const short = p => (p === info.home ? '~' : p.startsWith(info.home + '/') ? '~' + p.slice(info.home.length) : p)
  const qp = quickPick({
    title: 'Open Project: Enter browses into a folder, Tab opens it, Backspace goes up',
    placeholder: 'Filter folders',
    provider: async q => {
      if (!listing || listing.path !== cur) {
        try {
          listing = await get('/api/dirs', cur ? { path: cur } : undefined)
        } catch (e) {
          notify(e.message, 'error')
          listing = { path: cur, parent: null, dirs: [] }
        }
      }
      const items = []
      if (!q && cur) items.push({ label: `Open ${short(cur)}`, action: 'open', path: cur })
      if (!q && listing.parent) items.push({ label: '..', detail: short(listing.parent), action: 'browse', path: listing.parent })
      const isBases = !cur
      for (const d of listing.dirs) {
        const path = isBases ? d : cur + '/' + d
        const label = isBases ? short(d) : d + '/'
        const m = q ? fuzzy(q, label) : { score: 0, hits: [] }
        if (m) items.push({ label, hits: m.hits, score: m.score, action: 'browse', path })
      }
      if (q) items.sort((a, b) => b.score - a.score)
      return items.slice(0, 200)
    },
    onAccept: item => {
      if (!item) return false
      if (item.action === 'open') {
        switchProject(item.path)
        return
      }
      cur = item.path
      qp.setValue('')
      return false
    },
    onTab: item => {
      if (item && item.path) {
        qp.close(false)
        switchProject(item.path)
      }
    },
    onKey: (e, q) => {
      if (e.key === 'Backspace' && !q && listing?.parent) {
        cur = listing.parent
        qp.refresh()
        return true
      }
      return false
    },
  })
}

// ---------- quick open ----------

function quickOpen(initial = '') {
  const recent = recentFiles.slice()
  quickPick({
    placeholder: 'Go to file (append :line). Type > for commands, : for a line number',
    value: initial,
    onInput: (v, qp) => {
      if (v.startsWith('>')) {
        qp.close(false)
        commands.palette(v.slice(1))
      }
    },
    provider: async q => {
      if (q.startsWith(':')) {
        const [l, c] = q.slice(1).split(/[:,]/).map(Number)
        if (!tabs.active) return [{ label: 'Open a file first' }]
        return [{ label: l ? `Go to line ${l}${c ? `, column ${c}` : ''}` : `Type a line number (1-${tabs.active.view.lines.length})`, line: l, col: c || 1 }]
      }
      let files = []
      try {
        files = (await fm.listFiles()).files
      } catch (e) {
        return [{ label: e.message }]
      }
      const lm = /^(.*?):(\d+)(?::(\d+))?$/.exec(q)
      const query = (lm ? lm[1] : q).trim()
      const at = lm ? { line: +lm[2], col: +lm[3] || 1 } : {}
      if (!query) {
        const set = new Set(files)
        const rec = recent.filter(f => set.has(f))
        const rest = files.filter(f => !rec.includes(f))
        return rec.map(f => ({ label: f, detail: 'recent', path: f, ...at })).concat(rest.slice(0, 150).map(f => ({ label: f, path: f, ...at })))
      }
      const scored = []
      for (const f of files) {
        const m = fuzzyPath(query, f)
        if (m) scored.push({ label: f, path: f, hits: m.hits, score: m.score + (recent.includes(f) ? 50 : 0), ...at })
      }
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, 150)
    },
    onAccept: item => {
      if (!item) return
      if (item.path) openFile(item.path, { line: item.line, col: item.col })
      else if (item.line && tabs.active) tabs.active.view.gotoLine(item.line, item.col)
    },
  })
}

// ---------- commands ----------

function withView(fn) {
  return () => {
    const v = tabs.active?.view
    if (v) return fn(v, tabs.active)
  }
}

function registerCommands() {
  const R = commands.register
  const ed = { when: c => c.editorFocus }

  R('file.new', 'New File…', () => newFile(), { key: ['Ctrl+Shift+N', 'Alt+N'], category: 'File' })
  R('file.newFolder', 'New Folder…', () => newFolder(), { category: 'File' })
  R('file.quickOpen', 'Go to File…', () => quickOpen(), { key: 'Ctrl+P', category: 'File' })
  R('file.openProject', 'Open Project…', openProjectPicker, { key: 'Ctrl+O', category: 'File' })
  R('file.openRecentProject', 'Open Recent Project…', () => {
    quickPick({
      placeholder: 'Recent projects',
      items: (info.recent || []).map(p => ({ label: p.replace(info.home, '~'), path: p })),
      onAccept: it => it && switchProject(it.path),
    })
  }, { category: 'File' })
  R('file.save', 'Save', () => saveDoc(), { key: 'Ctrl+S', category: 'File' })
  R('file.saveAll', 'Save All', () => saveAll(), { key: 'Ctrl+Alt+S', category: 'File' })
  R('file.revert', 'Revert File', withView(async (v, doc) => {
    if (doc.virtual || !doc.dirty) return
    if ((await confirm({ title: `Revert ${doc.name}?`, message: 'Discard unsaved changes and reload from disk.', buttons: ['Revert', 'Cancel'] })) === 0) await fm.reload(doc)
  }), { category: 'File' })
  R('file.close', 'Close Tab', () => tabs.close(), { key: ['Ctrl+W', 'Alt+W'], category: 'File' })
  R('file.closeAll', 'Close All Tabs', () => tabs.closeAll(), { category: 'File' })
  R('file.closeOthers', 'Close Other Tabs', () => tabs.closeOthers(), { category: 'File' })
  R('file.rename', 'Rename Active File…', () => tabs.active && !tabs.active.virtual && renamePath(tabs.active.path), { key: 'F2', category: 'File' })
  R('file.delete', 'Delete Active File…', () => tabs.active && !tabs.active.virtual && deletePath(tabs.active.path), { category: 'File' })
  R('file.copyPath', 'Copy Path of Active File', () => tabs.active && copyText(info.root + '/' + tabs.active.path), { category: 'File' })
  R('file.settings', 'Open Settings (JSON)', () => openFile(SETTINGS_PATH), { key: 'Ctrl+,', category: 'Preferences' })
  R('file.refresh', 'Refresh Explorer', () => {
    fm.invalidate()
    explorer.refresh()
    fm.checkExternal()
  }, { category: 'File' })

  R('edit.undo', 'Undo', withView(v => (v.focus(), document.execCommand('undo'))), { category: 'Edit' })
  R('edit.redo', 'Redo', withView(v => (v.focus(), document.execCommand('redo'))), { category: 'Edit' })
  R('edit.find', 'Find', () => find.open(false), { key: 'Ctrl+F', category: 'Edit' })
  R('edit.replace', 'Replace', () => find.open(true), { key: 'Ctrl+H', category: 'Edit' })
  R('edit.findNext', 'Find Next', () => find.next(1), { key: 'F3', category: 'Edit' })
  R('edit.findPrev', 'Find Previous', () => find.next(-1), { key: 'Shift+F3', category: 'Edit' })
  R('edit.toggleComment', 'Toggle Line Comment', withView(v => v.toggleComment()), { key: 'Ctrl+/', ...ed, category: 'Edit' })
  R('edit.selectLine', 'Select Line', withView(v => v.selectLine()), { key: 'Ctrl+L', ...ed, category: 'Edit' })
  R('edit.selectNext', 'Select Word / Next Occurrence', withView(v => v.selectNextOccurrence()), { key: 'Ctrl+D', ...ed, category: 'Edit' })
  R('edit.deleteLine', 'Delete Line', withView(v => v.deleteLines()), { key: 'Ctrl+Shift+K', ...ed, category: 'Edit' })
  R('edit.moveLineUp', 'Move Line Up', withView(v => v.moveLines(-1)), { key: 'Alt+Up', ...ed, category: 'Edit' })
  R('edit.moveLineDown', 'Move Line Down', withView(v => v.moveLines(1)), { key: 'Alt+Down', ...ed, category: 'Edit' })
  R('edit.copyLineUp', 'Copy Line Up', withView(v => v.copyLines(-1)), { key: 'Shift+Alt+Up', ...ed, category: 'Edit' })
  R('edit.copyLineDown', 'Copy Line Down', withView(v => v.copyLines(1)), { key: 'Shift+Alt+Down', ...ed, category: 'Edit' })
  R('edit.indent', 'Indent Lines', withView(v => v.indentLines(1)), { key: 'Ctrl+]', ...ed, category: 'Edit' })
  R('edit.outdent', 'Outdent Lines', withView(v => v.indentLines(-1)), { key: 'Ctrl+[', ...ed, category: 'Edit' })
  R('edit.lineBelow', 'Insert Line Below', withView(v => v.insertLine(true)), { key: 'Ctrl+Enter', ...ed, category: 'Edit' })
  R('edit.lineAbove', 'Insert Line Above', withView(v => v.insertLine(false)), { key: 'Ctrl+Shift+Enter', ...ed, category: 'Edit' })
  R('edit.jumpBracket', 'Go to Matching Bracket', withView(v => v.jumpToBracket()), { key: 'Ctrl+Shift+\\', ...ed, category: 'Go' })
  R('edit.suggest', 'Trigger Autocomplete', withView(v => v.ac.trigger(true)), { key: 'Ctrl+Space', ...ed, category: 'Edit' })
  R('edit.searchProject', 'Search in Project', () => commands.execute('view.showSearch'), { category: 'Edit' })

  R('editor.language', 'Change Language Mode', withView((v, doc) => {
    quickPick({
      placeholder: 'Select language mode',
      items: languageIds().map(id => ({ label: langInfo(id).name, id, detail: id === doc.lang ? 'current' : '' })),
      onAccept: it => {
        if (!it) return
        doc.lang = it.id
        v.setLanguage(it.id)
        updateStatus()
      },
    })
  }), { category: 'Editor' })
  R('editor.indentation', 'Change Indentation', withView(v => {
    quickPick({
      placeholder: 'Indentation for this file',
      items: [
        { label: 'Spaces: 2', o: { size: 2, spaces: true } },
        { label: 'Spaces: 4', o: { size: 4, spaces: true } },
        { label: 'Spaces: 8', o: { size: 8, spaces: true } },
        { label: 'Tabs (width 4)', o: { size: 4, spaces: false } },
        { label: 'Tabs (width 8)', o: { size: 8, spaces: false } },
        { label: 'Detect from content', o: null },
      ],
      onAccept: it => {
        if (!it) return
        v.indentOverride = it.o
        v.applyConfig()
        updateStatus()
      },
    })
  }), { category: 'Editor' })
  R('editor.toggleEol', 'Toggle Line Endings (LF/CRLF)', withView((v, doc) => {
    doc.eol = doc.eol === '\n' ? '\r\n' : '\n'
    doc.saved = undefined
    doc.view.onChange()
    updateStatus()
  }), { category: 'Editor' })

  R('view.palette', 'Show All Commands', () => commands.palette(), { key: ['Ctrl+Shift+P', 'F1'], category: 'View' })
  R('view.toggleExplorer', 'Toggle Explorer', () => {
    if (layout.s.sidebar && layout.s.sideView !== 'explorer') layout.showSide('explorer', true)
    else {
      layout.s.sideView = 'explorer'
      layout.toggleSidebar()
    }
  }, { key: 'Ctrl+B', category: 'View' })
  R('view.showExplorer', 'Focus Explorer', () => layout.showSide('explorer', true), { key: 'Ctrl+Shift+E', category: 'View' })
  R('view.showSearch', 'Search in Project', () => {
    const v = tabs.active?.view
    let sel = ''
    if (v && layout.region() === 'editor') {
      const [s, e] = v.sel
      sel = v.text.slice(s, e)
      if (sel.includes('\n') || sel.length > 200) sel = ''
    }
    layout.showSide('search')
    search.focus(sel)
  }, { key: 'Ctrl+Shift+F', category: 'View' })
  R('view.togglePanel', 'Toggle Panel', () => layout.togglePanel(), { key: 'Ctrl+J', category: 'View' })
  R('view.toggleTerminal', 'Toggle Terminal', () => {
    const inPanel = layout.region() === 'panel' && layout.s.panelView === 'terminal'
    if (inPanel) layout.togglePanel(false)
    else layout.showPanel('terminal', true)
  }, { key: 'Ctrl+`', category: 'View' })
  R('view.showProblems', 'Show Problems', () => layout.showPanel('problems', true), { key: 'Ctrl+Shift+M', category: 'View' })
  R('view.showOutput', 'Show Output', () => layout.showPanel('output', true), { key: 'Ctrl+Shift+U', category: 'View' })
  R('view.maximizePanel', 'Toggle Maximized Panel', () => layout.toggleMaximize(), { key: 'Alt+M', category: 'View' })
  R('view.panelPosition', 'Cycle Panel Position (Auto/Bottom/Right)', () => notify('Panel position: ' + layout.cyclePosition()), { category: 'View' })
  R('view.growPanel', 'Increase Panel Size', () => layout.resizePanel(0.08), { category: 'View' })
  R('view.shrinkPanel', 'Decrease Panel Size', () => layout.resizePanel(-0.08), { category: 'View' })
  R('view.focusNext', 'Focus Next Region', () => layout.cycleFocus(1), { key: 'F6', category: 'View' })
  R('view.focusPrev', 'Focus Previous Region', () => layout.cycleFocus(-1), { key: 'Shift+F6', category: 'View' })
  R('view.focusEditor', 'Focus Editor', focusEditor, { key: 'Ctrl+1', category: 'View' })
  const setZoom = size => {
    zoom = Math.max(9, Math.min(28, size))
    configureEditor({ fontSize: zoom })
    saveState()
  }
  R('view.zoomIn', 'Increase Font Size', () => setZoom(editorConfig.fontSize + 1), { key: ['Ctrl+=', 'Ctrl+Shift+='], category: 'View' })
  R('view.zoomOut', 'Decrease Font Size', () => setZoom(editorConfig.fontSize - 1), { key: 'Ctrl+-', category: 'View' })
  R('view.zoomReset', 'Reset Font Size', () => {
    zoom = null
    configureEditor({ fontSize: +settings['editor.fontSize'] || 13 })
    saveState()
  }, { key: 'Ctrl+0', category: 'View' })
  R('view.menu', 'Focus Application Menu', () => document.querySelector('#menubar button')?.focus(), { key: 'F10', category: 'View' })
  R('view.shortcuts', 'Keyboard Shortcuts', () => commands.palette(), { category: 'Help' })

  R('go.file', 'Go to File…', () => quickOpen(), { category: 'Go' })
  R('go.line', 'Go to Line…', () => quickOpen(':'), { key: 'Ctrl+G', category: 'Go' })
  R('go.nextTab', 'Next Tab', () => tabs.next(1), { key: ['Alt+Right', 'Ctrl+PageDown'], category: 'Go' })
  R('go.prevTab', 'Previous Tab', () => tabs.next(-1), { key: ['Alt+Left', 'Ctrl+PageUp'], category: 'Go' })
  R('go.switchTab', 'Switch to Recent Tab', () => tabs.cycle(1), { key: 'Ctrl+Tab', category: 'Go' })
  R('go.switchTabBack', 'Switch to Recent Tab (Reverse)', () => tabs.cycle(-1), { key: 'Ctrl+Shift+Tab', category: 'Go' })
  for (let n = 1; n <= 9; n++) R('go.tab' + n, `Open Tab ${n}`, () => tabs.at(n), { key: 'Alt+' + n, category: 'Go', hidden: true })
  R('go.nextProblem', 'Next Problem', () => problems.step(1) || notify('No problems'), { key: 'F8', category: 'Go' })
  R('go.prevProblem', 'Previous Problem', () => problems.step(-1) || notify('No problems'), { key: 'Shift+F8', category: 'Go' })

  R('run.build', 'Build', () => tasks.build(), { key: 'Ctrl+Shift+B', category: 'Run' })
  R('run.run', 'Run', () => tasks.run(), { key: ['F5', 'Ctrl+R'], category: 'Run' })
  R('run.stop', 'Stop Build/Run', () => tasks.stop(), { key: 'Shift+F5', category: 'Run' })
  R('run.configure', 'Configure Tasks (.nexus.json)', async () => {
    try {
      await fm.read(TASKS_FILE)
    } catch (e) {
      if (e.status !== 404) throw e
      await put('/api/file', { path: TASKS_FILE, content: tasks.template() })
      fm.invalidate()
      explorer.refresh()
    }
    openFile(TASKS_FILE)
  }, { category: 'Run' })

  R('term.new', 'New Terminal', async () => {
    layout.showPanel('terminal')
    await terminal.create()
  }, { key: 'Ctrl+Shift+`', category: 'Terminal' })
  R('term.focus', 'Focus Terminal', () => layout.showPanel('terminal', true), { category: 'Terminal' })
  R('term.clear', 'Clear Terminal', () => terminal.clear(), { category: 'Terminal' })
  R('term.interrupt', 'Interrupt Running Command (SIGINT)', () => terminal.interrupt(), { category: 'Terminal' })
  R('term.kill', 'Kill Active Terminal', () => terminal.kill(), { category: 'Terminal' })
  R('term.next', 'Next Terminal', () => terminal.next(1), { key: 'Alt+PageDown', category: 'Terminal' })
  R('term.prev', 'Previous Terminal', () => terminal.next(-1), { key: 'Alt+PageUp', category: 'Terminal' })
  R('term.runSelection', 'Run Selected Text in Terminal', withView(async v => {
    const [s, e] = v.sel
    const text = (s === e ? v.lines[v.lineOf(s)] : v.text.slice(s, e)).trim()
    if (!text) return
    layout.showPanel('terminal')
    const sess = await terminal.ensureSession()
    if (sess.running) return notify('The terminal is busy', 'warn')
    terminal.exec(sess.id, text)
  }), { category: 'Terminal' })
  R('term.cdHere', 'Open Terminal in Active File\'s Folder', () => openTerminalAt(currentDir()), { category: 'Terminal' })

  R('workbench.escape', 'Escape', () => {
    if (dismissToasts()) return
    if (find.visible) return find.close()
    if (layout.narrow && layout.s.sidebar) {
      layout.toggleSidebar(false)
      return focusEditor()
    }
    if (layout.s.panelMax && layout.region() === 'panel') return layout.toggleMaximize()
    if (layout.region() !== 'editor') focusEditor()
  }, { key: 'Escape', hidden: true })
}

// ---------- menus ----------

const MENUS = [
  ['File', 'f', ['file.new', 'file.newFolder', 'file.quickOpen', '-', 'file.openProject', 'file.openRecentProject', '-', 'file.save', 'file.saveAll', 'file.revert', '-', 'file.rename', 'file.delete', 'file.copyPath', '-', 'file.close', 'file.closeOthers', 'file.closeAll', '-', 'file.settings']],
  ['Edit', 'e', ['edit.undo', 'edit.redo', '-', 'edit.find', 'edit.replace', 'view.showSearch', '-', 'edit.toggleComment', 'edit.selectLine', 'edit.selectNext', 'edit.deleteLine', 'edit.moveLineUp', 'edit.moveLineDown', 'edit.copyLineDown', 'edit.indent', 'edit.outdent', '-', 'edit.suggest', 'editor.language', 'editor.indentation']],
  ['View', 'v', ['view.palette', '-', 'view.toggleExplorer', 'view.showSearch', 'view.togglePanel', 'view.toggleTerminal', 'view.showProblems', 'view.showOutput', '-', 'view.maximizePanel', 'view.panelPosition', 'view.growPanel', 'view.shrinkPanel', '-', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset', '-', 'view.focusNext']],
  ['Go', 'g', ['go.file', 'go.line', 'edit.jumpBracket', '-', 'go.switchTab', 'go.nextTab', 'go.prevTab', '-', 'go.nextProblem', 'go.prevProblem']],
  ['Run', 'r', ['run.build', 'run.run', 'run.stop', '-', 'run.configure']],
  ['Terminal', 't', ['term.new', 'term.focus', 'term.next', 'term.prev', '-', 'term.clear', 'term.interrupt', 'term.kill', '-', 'term.runSelection', 'term.cdHere']],
]

function buildMenus() {
  const bar = document.getElementById('menubar')
  bar.innerHTML = ''
  const buttons = []
  const open = i => {
    const [, , ids] = MENUS[i]
    const items = ids.map(id => (id === '-' ? { sep: true } : { label: commandLabel(id), hint: commands.keyHint(id), run: () => commands.execute(id) }))
    buttons[i].classList.add('open')
    showMenu(items, buttons[i], {
      onNav: d => open((i + d + MENUS.length) % MENUS.length),
      onClose: () => buttons[i].classList.remove('open'),
    })
  }
  MENUS.forEach(([name, key], i) => {
    const b = el('button', 'menu-btn', { type: 'button', role: 'menuitem', 'aria-haspopup': 'true', html: `<u>${name[0]}</u>${name.slice(1)}` })
    b.addEventListener('click', () => open(i))
    b.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') buttons[(i + 1) % buttons.length].focus()
      else if (e.key === 'ArrowLeft') buttons[(i - 1 + buttons.length) % buttons.length].focus()
      else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') open(i)
      else if (e.key === 'Escape') focusEditor()
      else return
      e.preventDefault()
      e.stopPropagation()
    })
    bar.append(b)
    buttons.push(b)
    if (!commands.has('menu.' + name)) {
      commands.register('menu.' + name, `Open ${name} Menu`, () => document.querySelectorAll('#menubar .menu-btn')[i]?.click(), { key: 'Alt+' + key, hidden: true })
    }
  })
}

function commandLabel(id) {
  const t = commands.title(id)
  return t.includes(': ') ? t.slice(t.indexOf(': ') + 2) : t
}

// ---------- workspace state ----------

function collectState() {
  const dirty = {}
  let budget = 4 * 1024 * 1024
  for (const d of fm.dirtyDocs()) {
    if (d.virtual || d.view.text.length > budget) continue
    budget -= d.view.text.length
    dirty[d.path] = { content: d.view.text, mtime: d.mtime }
  }
  return {
    open: tabs.list.filter(d => !d.virtual).map(d => ({ path: d.path, view: d.view.getViewState() })),
    active: tabs.active && !tabs.active.virtual ? tabs.active.path : null,
    expanded: [...explorer.expanded],
    layout: layout.getState(),
    history: termHistory.slice(-500),
    recentFiles,
    recentCommands: commands.getRecent(),
    search: { q: search.q.value, include: search.include.value },
    zoom,
    dirty,
  }
}

const saveState = debounce(() => {
  if (!tabs) return
  const body = collectState()
  const size = JSON.stringify(body).length
  put('/api/state', body, { keepalive: size < 60000 }).catch(() => {})
}, 1200)

async function restore(ws) {
  termHistory.push(...(Array.isArray(ws.history) ? ws.history : []))
  recentFiles = Array.isArray(ws.recentFiles) ? ws.recentFiles : []
  commands.setRecent(ws.recentCommands)
  if (ws.search) {
    search.q.value = ws.search.q || ''
    search.include.value = ws.search.include || ''
  }
  layout.setState(ws.layout)
  explorer.expanded = new Set(['', ...(ws.expanded || [])])
  await explorer.refresh()

  const dirty = ws.dirty || {}
  const missing = []
  for (const entry of ws.open || []) {
    let doc
    try {
      doc = await fm.load(entry.path)
    } catch (e) {
      if (dirty[entry.path]) missing.push(entry.path)
      continue
    }
    const buf = dirty[entry.path]
    if (buf && buf.content !== doc.saved) {
      doc.view.setValue(buf.content)
      if (buf.mtime !== doc.mtime) notify(`${doc.name}: restored unsaved changes, but the file also changed on disk`, 'warn')
    }
    tabs.add(doc)
    doc.view.setViewState(entry.view)
  }
  if (missing.length) notify('Unsaved changes for deleted files were dropped: ' + missing.join(', '), 'warn')
  const active = ws.active && fm.get(ws.active)
  if (active) tabs.activate(active)
  else if (tabs.list.length) tabs.activate(tabs.list[0])
  else {
    renderWelcome()
    updateStatus()
    if (!layout.narrow) layout.showSide('explorer', true)
    else focusEditor()
  }
}

boot()
