import { get, put, post } from './api.js'
import { EditorView } from './editor.js'
import { langFor } from './syntax.js'
import { confirm, notify } from '../ui/dialog.js'
import { basename, debounce } from '../ui/dom.js'

export const SETTINGS_PATH = 'nexus:settings.json'

// Owns open documents: loading, saving, renames, and reconciling with changes on disk.
export class FileManager {
  constructor(hooks) {
    this.docs = new Map()
    this.hooks = hooks
    this.filesPromise = null
  }

  get(path) {
    return this.docs.get(path)
  }

  async read(path) {
    if (path === SETTINGS_PATH) {
      const data = await get('/api/settings')
      if (data.mtime == null && this.hooks.defaultSettings) data.content = this.hooks.defaultSettings()
      return data
    }
    return get('/api/file', { path })
  }

  makeDoc(path, data) {
    let text = data.content
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    if (eol !== '\n') text = text.replace(/\r\n/g, '\n')
    const doc = {
      path,
      name: path === SETTINGS_PATH ? 'settings.json' : basename(path),
      lang: path === SETTINGS_PATH ? 'json' : langFor(path, text.slice(0, text.indexOf('\n') >>> 0)),
      mtime: data.mtime,
      eol,
      saved: text,
      dirty: false,
      missing: false,
      virtual: path.startsWith('nexus:'),
      diagnostics: [],
    }
    doc.view = new EditorView(doc)
    doc.view.setValue(text)
    const diag = debounce(() => {
      if (!this.docs.has(doc.path)) return
      doc.diagnostics = doc.view.diagnostics()
      doc.view.setDiagnostics(doc.diagnostics.concat(this.hooks.extraDiagnostics?.(doc) || []))
      this.hooks.onDiagnostics?.(doc)
    }, 450)
    doc.view.onChange = () => {
      const dirty = doc.view.text !== doc.saved
      if (dirty !== doc.dirty) {
        doc.dirty = dirty
        this.hooks.onDirty?.(doc)
      }
      this.hooks.onChange?.(doc)
      diag()
    }
    doc.view.onCursor = () => this.hooks.onCursor?.(doc)
    diag()
    return doc
  }

  // Loads (or returns) a document without activating it.
  async load(path) {
    let doc = this.docs.get(path)
    if (doc) return doc
    const data = await this.read(path)
    doc = this.docs.get(path)
    if (doc) return doc
    doc = this.makeDoc(path, data)
    this.docs.set(path, doc)
    return doc
  }

  async save(doc) {
    const text = doc.view.text
    const content = doc.eol === '\n' ? text : text.replace(/\n/g, doc.eol)
    try {
      let res
      if (doc.path === SETTINGS_PATH) res = await put('/api/settings', { content })
      else res = await put('/api/file', { path: doc.path, content, mtime: doc.missing ? null : doc.mtime })
      this.markSaved(doc, text, res.mtime)
      return true
    } catch (e) {
      if (e.status !== 409) {
        notify(`Could not save ${doc.name}: ${e.message}`, 'error')
        return false
      }
      const choice = await confirm({
        title: `${doc.name} changed on disk`,
        message: 'The file was modified outside NEXUS after you opened it.',
        buttons: ['Overwrite', 'Reload from Disk', 'Cancel'],
      })
      if (choice === 0) {
        const res = await put('/api/file', { path: doc.path, content, force: true })
        this.markSaved(doc, text, res.mtime)
        return true
      }
      if (choice === 1) await this.reload(doc)
      return false
    }
  }

  markSaved(doc, text, mtime) {
    doc.saved = text
    doc.mtime = mtime
    doc.missing = false
    doc.dirty = doc.view.text !== text
    this.hooks.onDirty?.(doc)
    this.hooks.onSaved?.(doc)
  }

  async reload(doc) {
    const data = await this.read(doc.path)
    const text = data.content.replace(/\r\n/g, '\n')
    if (text !== doc.view.text) doc.view.replaceAllText(text)
    doc.saved = text
    doc.mtime = data.mtime
    doc.missing = false
    doc.dirty = false
    this.hooks.onDirty?.(doc)
  }

  // Reloads clean documents that changed on disk; flags deleted ones.
  async checkExternal() {
    const docs = [...this.docs.values()].filter(d => !d.virtual)
    if (!docs.length) return
    let st
    try {
      st = await post('/api/fs/stat', { paths: docs.map(d => d.path) })
    } catch {
      return
    }
    for (const d of docs) {
      const m = st[d.path]
      if (m == null) {
        if (!d.missing) {
          d.missing = true
          this.hooks.onDirty?.(d)
        }
        continue
      }
      if (d.missing) {
        d.missing = false
        this.hooks.onDirty?.(d)
      }
      if (Math.abs(m - d.mtime) <= 1) continue
      if (!d.dirty) await this.reload(d).catch(() => {})
      else if (d.warnedMtime !== m) {
        d.warnedMtime = m
        notify(`${d.name} changed on disk. Saving will ask before overwriting.`, 'warn')
      }
    }
  }

  async create(path, type = 'file') {
    const res = await post('/api/fs/create', { path, type })
    this.invalidate()
    return res.path
  }

  async rename(from, to) {
    const res = await post('/api/fs/rename', { from, to })
    const target = res.path
    for (const doc of [...this.docs.values()]) {
      if (doc.path !== from && !doc.path.startsWith(from + '/')) continue
      const old = doc.path
      this.docs.delete(old)
      doc.path = target + old.slice(from.length)
      doc.name = basename(doc.path)
      doc.view.ta.setAttribute('aria-label', 'Editor ' + doc.path)
      const lang = langFor(doc.path, doc.view.lines[0])
      if (lang !== doc.lang) {
        doc.lang = lang
        doc.view.setLanguage(lang)
      }
      this.docs.set(doc.path, doc)
      this.hooks.onRenamed?.(doc, old)
    }
    this.invalidate()
    return target
  }

  async remove(path) {
    await post('/api/fs/delete', { path })
    this.invalidate()
    return [...this.docs.values()].filter(d => d.path === path || d.path.startsWith(path + '/'))
  }

  invalidate() {
    this.filesPromise = null
  }

  listFiles() {
    if (!this.filesPromise) {
      this.filesPromise = get('/api/files').catch(e => {
        this.filesPromise = null
        throw e
      })
    }
    return this.filesPromise
  }

  dirtyDocs() {
    return [...this.docs.values()].filter(d => d.dirty)
  }
}
