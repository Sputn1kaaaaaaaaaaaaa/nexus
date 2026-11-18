import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { TerminalManager } from './terminal.js'
import * as files from './files.js'

const { HttpError, inside } = files
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(HERE, '..', 'dist')
const CONFIG_DIR = process.env.NEXUS_CONFIG_DIR || path.join(os.homedir(), '.nexus')
const MAX_BODY = 24 * 1024 * 1024
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const DEFAULT_PORT = 5370

const DEFAULT_EXPLORER_EXCLUDE = ['.git']
const DEFAULT_SEARCH_EXCLUDE = ['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', '.next', 'dist', 'build']

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writePrivate(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fsp.writeFile(file, data, { mode: 0o600 })
}

function realDir(p) {
  try {
    const real = fs.realpathSync(p)
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function findBash() {
  if (process.env.NEXUS_SHELL) return process.env.NEXUS_SHELL
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'bash')
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  throw new Error('bash was not found in PATH (Termux: pkg install bash)')
}

function loadToken() {
  if (process.env.NEXUS_TOKEN) return process.env.NEXUS_TOKEN
  const file = path.join(CONFIG_DIR, 'token')
  try {
    const t = fs.readFileSync(file, 'utf8').trim()
    if (t.length >= 32) return t
  } catch {}
  const t = crypto.randomBytes(24).toString('hex')
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, t + '\n', { mode: 0o600 })
  return t
}

function bases() {
  const list = process.env.NEXUS_BASE
    ? process.env.NEXUS_BASE.split(path.delimiter)
    : [os.homedir(), path.join(os.homedir(), 'storage', 'shared')]
  return [...new Set(list.map(realDir).filter(Boolean))]
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

const hostname = h => (h || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')

function sendJSON(res, status, data) {
  const body = JSON.stringify(data ?? null)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

export function createNexus({ root: rootArg } = {}) {
  const token = loadToken()
  const allowed = bases()
  const globalFile = path.join(CONFIG_DIR, 'state.json')
  const settingsFile = path.join(CONFIG_DIR, 'settings.json')
  const globalState = readJSON(globalFile, { recent: [] })
  let settings = {}

  const withinBase = p => allowed.some(b => inside(b, p))

  function loadSettings() {
    settings = readJSON(settingsFile, {})
    if (!settings || typeof settings !== 'object') settings = {}
  }
  loadSettings()

  const excludeSet = (key, def) => new Set(Array.isArray(settings[key]) ? settings[key] : def)

  function validateProject(p) {
    const real = p && realDir(path.resolve(String(p).replace(/^~(?=\/|$)/, os.homedir())))
    if (!real) throw new HttpError(400, 'Not a directory: ' + p)
    if (!withinBase(real)) throw new HttpError(403, 'Projects must be inside: ' + allowed.join(', '))
    return real
  }

  function pickRoot() {
    for (const c of [rootArg, process.env.NEXUS_ROOT, globalState.last, process.env.INIT_CWD, process.cwd(), os.homedir()]) {
      if (!c) continue
      try {
        return validateProject(c)
      } catch {}
    }
    throw new Error('No usable project directory found')
  }

  let root = pickRoot()

  function remember(dir) {
    globalState.last = dir
    globalState.recent = [dir, ...(globalState.recent || []).filter(d => d !== dir)].slice(0, 12)
    writePrivate(globalFile, JSON.stringify(globalState, null, 2)).catch(() => {})
  }
  remember(root)

  const stateFile = () => {
    const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 16)
    return path.join(CONFIG_DIR, 'workspaces', hash + '.json')
  }

  const terms = new TerminalManager({
    stateDir: path.join(CONFIG_DIR, 'sessions'),
    shell: findBash(),
    fallbackCwd: () => root,
  })

  // Server-sent events: one stream carries output for every terminal session.
  const clients = new Set()
  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    let congested = false
    for (const res of clients) {
      res.write(msg)
      if (res.writableLength > 2 * 1024 * 1024) congested = true
    }
    if (congested && !terms.paused) {
      terms.setPaused(true)
      const resume = () => {
        if ([...clients].every(r => r.writableLength < 256 * 1024)) terms.setPaused(false)
        else setTimeout(resume, 50)
      }
      setTimeout(resume, 50)
    }
  }
  for (const ev of ['data', 'start', 'exit', 'created', 'closed']) terms.on(ev, d => broadcast(ev, d))
  const ping = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n')
  }, 20000)

  function events(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const sessions = [...terms.sessions.values()].map(s => ({ ...terms.info(s), scrollback: s.scrollback }))
    res.write(`event: hello\ndata: ${JSON.stringify({ sessions })}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
  }

  const info = () => ({
    root,
    name: path.basename(root),
    home: os.homedir(),
    bases: allowed,
    recent: (globalState.recent || []).filter(d => realDir(d)),
    platform: process.platform,
    termux: !!process.env.TERMUX_VERSION || root.startsWith('/data/data/com.termux'),
  })

  function sessionCwd(cwd) {
    if (!cwd) return root
    const abs = realDir(path.resolve(root, cwd))
    if (!abs || !withinBase(abs)) throw new HttpError(400, 'Invalid working directory')
    return abs
  }

  async function listDirs(p) {
    if (!p) return { path: null, parent: null, dirs: allowed }
    const dir = validateProject(p)
    const ents = await fsp.readdir(dir, { withFileTypes: true })
    const dirs = []
    for (const e of ents) {
      if (e.isDirectory() || (e.isSymbolicLink() && realDir(path.join(dir, e.name)))) dirs.push(e.name)
    }
    dirs.sort((a, b) => (a[0] === '.') - (b[0] === '.') || a.localeCompare(b, undefined, { sensitivity: 'base' }))
    const up = path.dirname(dir)
    return { path: dir, parent: up !== dir && withinBase(up) ? up : null, dirs }
  }

  const routes = {
    'GET /api/info': () => info(),
    'POST /api/project': async ({ body }) => {
      root = validateProject(body.path)
      remember(root)
      return info()
    },
    'GET /api/dirs': ({ q }) => listDirs(q.get('path')),
    'GET /api/tree': ({ q }) => files.listDir(root, q.get('path') || '', excludeSet('files.exclude', DEFAULT_EXPLORER_EXCLUDE)),
    'GET /api/files': () => files.walk(root, excludeSet('search.exclude', DEFAULT_SEARCH_EXCLUDE)),
    'GET /api/file': ({ q }) => files.readFile(root, q.get('path')),
    'PUT /api/file': ({ body }) => files.writeFile(root, body.path, body.content, body.mtime, body.force),
    'POST /api/fs/create': ({ body }) => files.create(root, body.path, body.type),
    'POST /api/fs/rename': ({ body }) => files.rename(root, body.from, body.to),
    'POST /api/fs/delete': ({ body }) => files.remove(root, body.path),
    'POST /api/fs/stat': ({ body }) => files.stat(root, Array.isArray(body.paths) ? body.paths : []),
    'GET /api/search': ({ q }) =>
      files.search(
        root,
        {
          q: q.get('q') || '',
          regex: q.get('regex') === '1',
          caseSensitive: q.get('case') === '1',
          word: q.get('word') === '1',
          include: q.get('include') || '',
        },
        excludeSet('search.exclude', DEFAULT_SEARCH_EXCLUDE),
      ),
    'GET /api/state': () => readJSON(stateFile(), {}),
    'PUT /api/state': async ({ body }) => {
      await writePrivate(stateFile(), JSON.stringify(body))
      return { ok: true }
    },
    'GET /api/settings': async () => {
      try {
        const st = await fsp.stat(settingsFile)
        return { content: await fsp.readFile(settingsFile, 'utf8'), mtime: st.mtimeMs }
      } catch {
        return { content: '{\n}\n', mtime: null }
      }
    },
    'PUT /api/settings': async ({ body }) => {
      if (typeof body.content !== 'string') throw new HttpError(400, 'Missing content')
      await writePrivate(settingsFile, body.content)
      loadSettings()
      return { mtime: (await fsp.stat(settingsFile)).mtimeMs }
    },
    'GET /api/term/sessions': () => terms.list(),
    'POST /api/term/create': ({ body }) => terms.create({ cwd: sessionCwd(body.cwd), name: body.name, hidden: body.hidden }),
    'POST /api/term/exec': ({ body }) => terms.exec(body.id, body.command, body.cols),
    'POST /api/term/input': ({ body }) => {
      terms.input(body.id, body.data)
      return { ok: true }
    },
    'POST /api/term/eof': ({ body }) => {
      terms.eof(body.id)
      return { ok: true }
    },
    'POST /api/term/signal': ({ body }) => {
      terms.signal(body.id, body.signal)
      return { ok: true }
    },
    'POST /api/term/close': ({ body }) => {
      terms.close(body.id)
      return { ok: true }
    },
    'POST /api/term/complete': ({ body }) => terms.complete(body.id, String(body.line || '')),
  }

  async function handleApi(req, res, url) {
    if (!LOCAL_HOSTS.has(hostname(req.headers.host))) return sendJSON(res, 403, { error: 'Forbidden host' })
    const origin = req.headers.origin
    if (origin) {
      let ok = false
      try {
        const u = new URL(origin)
        ok = LOCAL_HOSTS.has(hostname(u.host)) && u.host === req.headers.host
      } catch {}
      if (!ok) return sendJSON(res, 403, { error: 'Forbidden origin' })
    }
    const key = req.method + ' ' + url.pathname
    if (key === 'POST /api/auth') {
      const body = await readBody(req)
      if (!safeEqual(body.token || '', token)) return sendJSON(res, 401, { error: 'Invalid token' })
      res.setHeader('Set-Cookie', `nexus_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`)
      return sendJSON(res, 200, { ok: true })
    }
    const cookie = /(?:^|;\s*)nexus_token=([^;]+)/.exec(req.headers.cookie || '')
    if (!cookie || !safeEqual(decodeURIComponent(cookie[1]), token)) return sendJSON(res, 401, { error: 'Unauthorized' })
    if (key === 'GET /api/term/events') return events(req, res)
    if (req.headers['x-nexus'] !== '1') return sendJSON(res, 403, { error: 'Missing X-Nexus header' })
    const handler = routes[key]
    if (!handler) return sendJSON(res, 404, { error: 'Not found' })
    try {
      const body = req.method === 'GET' ? {} : await readBody(req)
      sendJSON(res, 200, await handler({ req, body, q: url.searchParams }))
    } catch (e) {
      const status = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500)
      sendJSON(res, status, { error: e.message, ...(e.data || {}) })
    }
  }

  function handle(req, res, next) {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch(e => sendJSON(res, e.status || 500, { error: e.message }))
    } else if (next) next()
    else serveStatic(url, res)
  }

  function close() {
    clearInterval(ping)
    for (const res of clients) res.end()
    terms.closeAll()
  }

  return { handle, close, token, get root() { return root } }
}

async function serveStatic(url, res) {
  let rel = decodeURIComponent(url.pathname)
  let file = path.join(DIST, rel)
  if (!inside(DIST, file)) {
    res.writeHead(403)
    return res.end()
  }
  try {
    if ((await fsp.stat(file)).isDirectory()) file = path.join(file, 'index.html')
    await fsp.access(file)
  } catch {
    file = path.join(DIST, 'index.html')
  }
  try {
    const data = await fsp.readFile(file)
    const isIndex = file.endsWith('index.html')
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    res.end(data)
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('NEXUS frontend is not built. Run: npm run build')
  }
}

export function startUrl(port, token) {
  return `http://127.0.0.1:${port}/?token=${token}`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  const portIdx = args.indexOf('--port')
  const port = Number(portIdx >= 0 ? args.splice(portIdx, 2)[1] : process.env.NEXUS_PORT || DEFAULT_PORT)
  let nexus
  try {
    nexus = createNexus({ root: args[0] })
  } catch (e) {
    console.error('nexus: ' + e.message)
    process.exit(1)
  }
  const server = http.createServer((req, res) => nexus.handle(req, res))
  server.on('error', e => {
    console.error('nexus: ' + e.message)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  NEXUS  project: ${nexus.root}`)
    console.log(`  Open:  ${startUrl(port, nexus.token)}\n`)
  })
  const shutdown = () => {
    nexus.close()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
