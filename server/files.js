import fsp from 'node:fs/promises'
import path from 'node:path'

const MAX_READ = 8 * 1024 * 1024
const MAX_SEARCH_FILE = 1024 * 1024

export class HttpError extends Error {
  constructor(status, message, data) {
    super(message)
    this.status = status
    this.data = data
  }
}

export function inside(base, p) {
  return p === base || p.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
}

export const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/')

// Resolves a project-relative path and refuses anything (including symlink targets) outside root.
export async function resolveSafe(root, rel = '', { follow = true } = {}) {
  const abs = path.resolve(root, String(rel).replace(/^\/+/, ''))
  if (!inside(root, abs)) throw new HttpError(403, 'Path is outside the project')
  let p = follow ? abs : path.dirname(abs)
  for (;;) {
    try {
      const real = await fsp.realpath(p)
      if (!inside(root, real)) throw new HttpError(403, 'Path escapes the project through a symlink')
      return abs
    } catch (e) {
      if (e instanceof HttpError) throw e
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
      const up = path.dirname(p)
      if (up === p) return abs
      p = up
    }
  }
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

export async function listDir(root, rel, exclude) {
  const abs = await resolveSafe(root, rel)
  const ents = await fsp.readdir(abs, { withFileTypes: true })
  const out = []
  for (const e of ents) {
    if (exclude.has(e.name)) continue
    let type = e.isDirectory() ? 'dir' : 'file'
    if (e.isSymbolicLink()) {
      try {
        type = (await fsp.stat(path.join(abs, e.name))).isDirectory() ? 'dir' : 'file'
      } catch {
        type = 'file'
      }
    }
    out.push({ name: e.name, type })
  }
  const dirs = out.filter(e => e.type === 'dir').sort(byName)
  return dirs.concat(out.filter(e => e.type !== 'dir').sort(byName))
}

export async function walk(root, exclude, max = 20000) {
  const files = []
  const stack = ['']
  while (stack.length && files.length < max) {
    const dir = stack.pop()
    let ents
    try {
      ents = await fsp.readdir(path.join(root, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (exclude.has(e.name)) continue
      const rel = dir ? dir + '/' + e.name : e.name
      if (e.isDirectory()) stack.push(rel)
      else if (e.isFile()) files.push(rel)
      else if (e.isSymbolicLink()) {
        try {
          if ((await fsp.stat(path.join(root, rel))).isFile()) files.push(rel)
        } catch {}
      }
    }
  }
  files.sort()
  return { files, truncated: stack.length > 0 }
}

export async function readFile(root, rel) {
  const abs = await resolveSafe(root, rel)
  const st = await fsp.stat(abs)
  if (st.isDirectory()) throw new HttpError(400, 'Is a directory')
  if (st.size > MAX_READ) throw new HttpError(413, 'File is too large to edit (over 8 MB)')
  const buf = await fsp.readFile(abs)
  if (isBinary(buf)) throw new HttpError(415, 'Binary file cannot be opened in the editor')
  return { path: toRel(root, abs), content: buf.toString('utf8'), mtime: st.mtimeMs }
}

export async function writeFile(root, rel, content, mtime, force) {
  if (typeof content !== 'string') throw new HttpError(400, 'Missing content')
  const abs = await resolveSafe(root, rel)
  if (abs === root) throw new HttpError(400, 'Invalid path')
  if (!force && mtime != null) {
    try {
      const st = await fsp.stat(abs)
      if (Math.abs(st.mtimeMs - mtime) > 1) {
        throw new HttpError(409, 'File changed on disk since it was opened', { mtime: st.mtimeMs })
      }
    } catch (e) {
      if (e instanceof HttpError) throw e
    }
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, content, 'utf8')
  return { mtime: (await fsp.stat(abs)).mtimeMs }
}

export async function create(root, rel, type) {
  const abs = await resolveSafe(root, rel)
  if (abs === root) throw new HttpError(400, 'Invalid path')
  try {
    await fsp.lstat(abs)
    throw new HttpError(409, 'A file or folder with that name already exists')
  } catch (e) {
    if (e instanceof HttpError) throw e
  }
  if (type === 'dir') await fsp.mkdir(abs, { recursive: true })
  else {
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, '', { flag: 'wx' })
  }
  return { path: toRel(root, abs) }
}

export async function rename(root, from, to) {
  const src = await resolveSafe(root, from, { follow: false })
  const dst = await resolveSafe(root, to)
  if (src === root || dst === root) throw new HttpError(400, 'Invalid path')
  if (inside(src, dst) && src !== dst) throw new HttpError(400, 'Cannot move a folder into itself')
  if (src.toLowerCase() !== dst.toLowerCase()) {
    try {
      await fsp.lstat(dst)
      throw new HttpError(409, 'Target already exists')
    } catch (e) {
      if (e instanceof HttpError) throw e
    }
  }
  await fsp.mkdir(path.dirname(dst), { recursive: true })
  await fsp.rename(src, dst)
  return { path: toRel(root, dst) }
}

export async function remove(root, rel) {
  const abs = await resolveSafe(root, rel, { follow: false })
  if (abs === root) throw new HttpError(400, 'Refusing to delete the project root')
  await fsp.rm(abs, { recursive: true })
  return { ok: true }
}

export async function stat(root, paths) {
  const out = {}
  for (const p of paths.slice(0, 500)) {
    try {
      out[p] = (await fsp.stat(await resolveSafe(root, p))).mtimeMs
    } catch {
      out[p] = null
    }
  }
  return out
}

function globToRegex(glob) {
  const parts = glob.split(',').map(g => g.trim()).filter(Boolean)
  if (!parts.length) return null
  const src = parts.map(g => {
    let re = ''
    for (let i = 0; i < g.length; i++) {
      const c = g[i]
      if (c === '*' && g[i + 1] === '*') {
        re += '.*'
        i++
        if (g[i + 1] === '/') i++
      } else if (c === '*') re += '[^/]*'
      else if (c === '?') re += '[^/]'
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    return g.includes('/') ? '^' + re + '$' : '(^|/)' + re + '$'
  })
  return new RegExp(src.join('|'), 'i')
}

export async function search(root, opts, exclude) {
  const { q, regex, caseSensitive, word, include } = opts
  if (!q) return { results: [], truncated: false }
  let src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (word) src = '\\b(?:' + src + ')\\b'
  let re
  try {
    re = new RegExp(src, caseSensitive ? 'g' : 'gi')
  } catch (e) {
    throw new HttpError(400, 'Invalid regular expression: ' + e.message)
  }
  const inc = include ? globToRegex(include) : null
  const { files } = await walk(root, exclude)
  const results = []
  let total = 0
  let truncated = false
  for (const rel of files) {
    if (inc && !inc.test(rel)) continue
    if (total >= 2000) {
      truncated = true
      break
    }
    let buf
    try {
      const abs = path.join(root, rel)
      if ((await fsp.stat(abs)).size > MAX_SEARCH_FILE) continue
      buf = await fsp.readFile(abs)
    } catch {
      continue
    }
    if (isBinary(buf)) continue
    const lines = buf.toString('utf8').split('\n')
    const matches = []
    for (let i = 0; i < lines.length && matches.length < 100; i++) {
      const line = lines[i]
      re.lastIndex = 0
      let m
      while ((m = re.exec(line)) && matches.length < 100) {
        if (!m[0].length) {
          re.lastIndex++
          continue
        }
        let text = line
        let col = m.index
        if (line.length > 240) {
          const from = Math.max(0, m.index - 60)
          text = line.slice(from, from + 240)
          col -= from
        }
        matches.push({ line: i + 1, col: m.index + 1, len: m[0].length, text: text.replace(/\r$/, ''), at: col })
      }
    }
    if (matches.length) {
      results.push({ path: rel, matches })
      total += matches.length
    }
  }
  return { results, truncated }
}
