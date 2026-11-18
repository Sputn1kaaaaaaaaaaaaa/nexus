// Line-based tokenizers. Each takes (text, state, emit) and returns the state at line end,
// so the editor can cache states and only re-tokenize what is visible.

const words = s => new Set(s.split(/\s+/).filter(Boolean))

const C_KW = 'auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while _Bool _Static_assert _Noreturn _Alignas _Alignof _Atomic _Thread_local'
const C_TYPES = 'void char short int long float double signed unsigned bool size_t ssize_t ptrdiff_t intptr_t uintptr_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE wchar_t va_list off_t pid_t time_t'
const C_CONST = 'NULL true false EOF stdin stdout stderr EXIT_SUCCESS EXIT_FAILURE __FILE__ __LINE__ __func__'
const C_FN = 'printf scanf fprintf sprintf snprintf sscanf malloc calloc realloc free memcpy memset memmove memcmp strlen strcpy strncpy strcmp strncmp strcat strchr strstr strtok puts gets fgets fputs fopen fclose fread fwrite fseek ftell exit abort assert getchar putchar atoi atof strtol qsort rand srand time sqrt pow abs'
const CPP_KW = 'alignas alignof and asm catch class concept consteval constexpr constinit co_await co_return co_yield decltype delete explicit export friend mutable namespace new noexcept not operator or private protected public requires static_assert static_cast dynamic_cast reinterpret_cast const_cast template this thread_local throw try typeid typename using virtual override final'
const CPP_TYPES = 'string string_view vector map set multimap unordered_map unordered_set pair tuple array deque list queue priority_queue stack optional variant shared_ptr unique_ptr weak_ptr function size_type'
const CPP_CONST = 'nullptr std cout cin cerr endl'
const CPP_FN = 'make_shared make_unique move forward swap sort find begin end push_back emplace_back getline to_string stoi'
const JS_KW = 'async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch throw try typeof var void while with yield interface type enum implements declare readonly abstract private public protected as'
const JS_CONST = 'true false null undefined NaN Infinity this'
const JS_FN = 'console Math JSON Object Array String Number Boolean Promise Map Set WeakMap WeakSet Symbol Date RegExp Error TypeError RangeError parseInt parseFloat isNaN require module exports process globalThis window document navigator setTimeout setInterval clearTimeout clearInterval requestAnimationFrame fetch Buffer URL structuredClone'
const PY_KW = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'
const PY_CONST = 'True False None self cls __name__ __main__ __init__'
const PY_FN = 'print len range int str float list dict set tuple bool bytes type isinstance issubclass open input enumerate zip map filter sorted reversed sum min max abs round any all super object iter next repr hash id dir vars getattr setattr hasattr format chr ord divmod pow Exception ValueError TypeError KeyError IndexError RuntimeError StopIteration'
const SH_KW = 'if then else elif fi for while until do done case esac function in select return break continue local export readonly declare unset time'
const SH_FN = 'echo cd printf read source exit set shift test eval exec trap alias cat ls grep sed awk mkdir rm cp mv chmod chown pwd sort uniq find xargs head tail wc touch ln tar curl wget git make gcc clang python python3 node npm pkg apt'

const LANGS = {
  c: {
    name: 'C', kind: 'generic', line: '//', block: ['/*', '*/'], quotes: `"'`, pp: true,
    kw: words(C_KW), types: words(C_TYPES), consts: words(C_CONST), fns: words(C_FN),
  },
  cpp: {
    name: 'C++', kind: 'generic', line: '//', block: ['/*', '*/'], quotes: `"'`, pp: true,
    kw: words(C_KW + ' ' + CPP_KW), types: words(C_TYPES + ' ' + CPP_TYPES), consts: words(C_CONST + ' ' + CPP_CONST), fns: words(C_FN + ' ' + CPP_FN),
  },
  javascript: {
    name: 'JavaScript', kind: 'generic', line: '//', block: ['/*', '*/'], quotes: '"\'`', multi: '`', regex: true,
    kw: words(JS_KW), types: new Set(), consts: words(JS_CONST), fns: words(JS_FN), pairs: '()[]{}""\'\'``',
  },
  python: {
    name: 'Python', kind: 'generic', line: '#', quotes: `"'`, triple: true, decorators: true, indentColon: true,
    kw: words(PY_KW), types: new Set(), consts: words(PY_CONST), fns: words(PY_FN),
  },
  shell: {
    name: 'Shell', kind: 'generic', line: '#', quotes: `"'`, multi: `"'`, vars: true, shellComment: true,
    kw: words(SH_KW), types: new Set(), consts: words('true false'), fns: words(SH_FN),
  },
  json: {
    name: 'JSON', kind: 'generic', quotes: '"', keys: true,
    kw: new Set(), types: new Set(), consts: words('true false null'), fns: new Set(),
  },
  css: { name: 'CSS', kind: 'css', block: ['/*', '*/'], kw: new Set(), consts: new Set(), fns: new Set() },
  html: { name: 'HTML', kind: 'html', block: ['<!--', '-->'], kw: new Set(), consts: new Set(), fns: new Set() },
  markdown: { name: 'Markdown', kind: 'md', kw: new Set(), consts: new Set(), fns: new Set() },
  plaintext: { name: 'Plain Text', kind: 'plain', kw: new Set(), consts: new Set(), fns: new Set() },
}

const EXT = {
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript',
  py: 'python', pyw: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', env: 'shell',
  json: 'json', jsonc: 'json', webmanifest: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xhtml: 'html', xml: 'html', svg: 'html', vue: 'html',
  md: 'markdown', markdown: 'markdown',
}
const NAMES = {
  makefile: 'shell', gnumakefile: 'shell', dockerfile: 'shell', '.bashrc': 'shell', '.profile': 'shell',
  '.bash_profile': 'shell', '.zshrc': 'shell', 'pkgbuild': 'shell', 'build.sh': 'shell',
}

export function langFor(path, firstLine = '') {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (NAMES[name]) return NAMES[name]
  const dot = name.lastIndexOf('.')
  if (dot > 0 && EXT[name.slice(dot + 1)]) return EXT[name.slice(dot + 1)]
  if (/^#!.*\b(ba|z|k)?sh\b/.test(firstLine)) return 'shell'
  if (/^#!.*python/.test(firstLine)) return 'python'
  if (/^#!.*node/.test(firstLine)) return 'javascript'
  return 'plaintext'
}

export const langInfo = id => LANGS[id] || LANGS.plaintext
export const languageIds = () => Object.keys(LANGS)

function scanQuoted(text, i, close, escapes = true) {
  const n = text.length
  while (i < n) {
    if (escapes && text[i] === '\\') {
      i += 2
      continue
    }
    if (text.startsWith(close, i)) return i + close.length
    i++
  }
  return -1
}

const NUM = /^(?:0[xX][\da-fA-F_']+|0[bB][01_']+|(?:\d[\d_']*\.?[\d_']*|\.\d[\d_']*)(?:[eE][+-]?\d+)?)[a-zA-Z]*/
const OPS = '+-*/%=&|^!<>?:~@#\\'
const ID_START = /[A-Za-z_\u00c0-\uffff]/
const ID = /^[\w$\u00c0-\uffff]+/
const ID_NO_DOLLAR = /^[\w\u00c0-\uffff]+/
const REGEX = /^\/(?![*/])(?:[^\\/[\n]|\\.|\[(?:[^\\\]\n]|\\.)*\])+\/[a-z]*/

function generic(L, text, state, emit) {
  const n = text.length
  let i = 0
  if (state === 'bc') {
    const e = text.indexOf(L.block[1])
    if (e < 0) {
      emit('cm', text)
      return 'bc'
    }
    i = e + L.block[1].length
    emit('cm', text.slice(0, i))
  } else if (state && state[0] === 'q') {
    const close = state.slice(1)
    const e = scanQuoted(text, 0, close, !(L.vars && close === "'"))
    if (e < 0) {
      emit('str', text)
      return state
    }
    i = e
    emit('str', text.slice(0, e))
  }
  let prev = i > 0 ? 'v' : ''
  let lineStart = i === 0
  while (i < n) {
    const c = text[i]
    if (c === ' ' || c === '\t') {
      let j = i + 1
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j++
      emit('', text.slice(i, j))
      i = j
      continue
    }
    if (L.line && text.startsWith(L.line, i) && (!L.shellComment || i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      emit('cm', text.slice(i))
      return ''
    }
    if (L.block && text.startsWith(L.block[0], i)) {
      const e = text.indexOf(L.block[1], i + L.block[0].length)
      if (e < 0) {
        emit('cm', text.slice(i))
        return 'bc'
      }
      emit('cm', text.slice(i, e + L.block[1].length))
      i = e + L.block[1].length
      continue
    }
    if (L.pp && c === '#' && lineStart) {
      const m = /^#\s*\w*/.exec(text.slice(i))[0]
      emit('meta', m)
      i += m.length
      if (/include|import/.test(m)) {
        const r = /^(\s*)(<[^>]*>)/.exec(text.slice(i))
        if (r) {
          emit('', r[1])
          emit('str', r[2])
          i += r[0].length
        }
      }
      lineStart = false
      continue
    }
    lineStart = false
    if (L.quotes.includes(c)) {
      let close = c
      if (L.triple && text.startsWith(c + c + c, i)) close = c + c + c
      const e = scanQuoted(text, i + close.length, close, !(L.vars && c === "'"))
      if (e < 0) {
        emit('str', text.slice(i))
        return close.length === 3 || (L.multi && L.multi.includes(c)) ? 'q' + close : ''
      }
      emit(L.keys && /^\s*:/.test(text.slice(e)) ? 'prop' : 'str', text.slice(i, e))
      i = e
      prev = 'v'
      continue
    }
    if ((c >= '0' && c <= '9') || (c === '.' && text[i + 1] >= '0' && text[i + 1] <= '9')) {
      const m = NUM.exec(text.slice(i))[0]
      emit('num', m)
      i += m.length
      prev = 'v'
      continue
    }
    if (L.vars && c === '$') {
      const m = /^\$(?:\{[^}]*\}?|\w+|[@*#?$!0-9-])?/.exec(text.slice(i))[0]
      emit('var', m)
      i += m.length
      prev = 'v'
      continue
    }
    if (L.decorators && c === '@') {
      const m = /^@[\w.]*/.exec(text.slice(i))[0]
      emit('meta', m)
      i += m.length
      continue
    }
    if (ID_START.test(c) || (c === '$' && !L.vars)) {
      const m = (L.vars ? ID_NO_DOLLAR : ID).exec(text.slice(i))[0]
      const j = i + m.length
      if (L.triple && /^[rbfuRBFU]{1,2}$/.test(m) && L.quotes.includes(text[j])) {
        emit('str', m)
        i = j
        continue
      }
      let type = L.kw.has(m) ? 'kw' : L.types.has(m) ? 'type' : L.consts.has(m) ? 'const' : L.fns.has(m) ? 'fn2' : ''
      if (!type) {
        let k = j
        while (text[k] === ' ') k++
        if (text[k] === '(') type = 'fn'
        else if (L.vars && text[k] === '=' && prev === '') type = 'var'
      }
      emit(type, m)
      i = j
      prev = type === 'kw' ? 'k' : 'v'
      continue
    }
    if (L.regex && c === '/' && prev !== 'v') {
      const m = REGEX.exec(text.slice(i))
      if (m) {
        emit('re', m[0])
        i += m[0].length
        prev = 'v'
        continue
      }
    }
    if ('()[]{}'.includes(c)) {
      emit('br', c)
      i++
      prev = ')]}'.includes(c) ? 'v' : 'o'
      continue
    }
    if (OPS.includes(c)) {
      let j = i + 1
      while (
        j < n && OPS.includes(text[j]) &&
        !(L.line && text.startsWith(L.line, j)) && !(L.block && text.startsWith(L.block[0], j)) &&
        !(L.regex && text[j] === '/')
      ) j++
      emit('op', text.slice(i, j))
      i = j
      prev = 'o'
      continue
    }
    emit('', c)
    if (c !== '.') prev = c === ',' || c === ';' ? 'o' : prev
    i++
  }
  return ''
}

function css(text, state, emit) {
  const n = text.length
  let inComment = state[0] === 'c'
  let depth = parseInt(state.replace('c', ''), 10) || 0
  let i = 0
  if (inComment) {
    const e = text.indexOf('*/')
    if (e < 0) {
      emit('cm', text)
      return state
    }
    emit('cm', text.slice(0, e + 2))
    i = e + 2
  }
  let inValue = false
  const isSelector = () => depth === 0 || /^[^;{}]*\{/.test(text.slice(i))
  let sel = isSelector()
  while (i < n) {
    const c = text[i]
    const rest = text.slice(i)
    if (c === ' ' || c === '\t') {
      const m = /^[ \t]+/.exec(rest)[0]
      emit('', m)
      i += m.length
      continue
    }
    if (rest.startsWith('/*')) {
      const e = text.indexOf('*/', i + 2)
      if (e < 0) {
        emit('cm', rest)
        return 'c' + (depth || '')
      }
      emit('cm', text.slice(i, e + 2))
      i = e + 2
      continue
    }
    if (c === '"' || c === "'") {
      const e = scanQuoted(text, i + 1, c)
      const end = e < 0 ? n : e
      emit('str', text.slice(i, end))
      i = end
      continue
    }
    if (c === '{' || c === '}') {
      depth = Math.max(0, depth + (c === '{' ? 1 : -1))
      emit('br', c)
      i++
      inValue = false
      sel = isSelector()
      continue
    }
    if (c === ';') {
      emit('', c)
      i++
      inValue = false
      sel = isSelector()
      continue
    }
    if (c === '@') {
      const m = /^@[\w-]*/.exec(rest)[0]
      emit('kw', m)
      i += m.length
      continue
    }
    if (c === '!' && /^!important/i.test(rest)) {
      emit('kw', rest.slice(0, 10))
      i += 10
      continue
    }
    if (sel && !inValue) {
      let m
      if ((m = /^\.[\w-]+/.exec(rest))) emit('type', m[0])
      else if ((m = /^#[\w-]+/.exec(rest))) emit('fn', m[0])
      else if ((m = /^::?[\w-]+/.exec(rest))) emit('kw', m[0])
      else if ((m = /^\[[^\]]*\]?/.exec(rest))) emit('prop', m[0])
      else if ((m = /^[a-zA-Z][\w-]*/.exec(rest))) emit('tag', m[0])
      else if ((m = /^\d[\d.]*%?/.exec(rest))) emit('num', m[0])
      else m = [c], emit('op', c)
      i += m[0].length
      continue
    }
    let m
    if ((m = /^#[\da-fA-F]{3,8}\b/.exec(rest)) && inValue) emit('num', m[0])
    else if ((m = /^-?(?:\d+\.?\d*|\.\d+)(?:[a-zA-Z]+|%)?/.exec(rest))) emit('num', m[0])
    else if ((m = /^-?-?[a-zA-Z_][\w-]*/.exec(rest))) {
      const after = text.slice(i + m[0].length)
      if (!inValue && /^\s*:/.test(after)) emit('prop', m[0])
      else if (after[0] === '(') emit('fn', m[0])
      else emit('val', m[0])
    } else {
      m = [c]
      if (c === ':') inValue = true
      emit(c === ':' || c === ',' ? '' : 'op', c)
    }
    i += m[0].length
  }
  return depth ? String(depth) : ''
}

function html(text, state, emit) {
  const n = text.length
  let i = 0
  while (i < n) {
    if (state.startsWith('js:') || state.startsWith('css:')) {
      const js = state.startsWith('js:')
      const inner = state.slice(js ? 3 : 4)
      const m = (js ? /<\/script/i : /<\/style/i).exec(text.slice(i))
      const end = m ? i + m.index : n
      const out = js ? generic(LANGS.javascript, text.slice(i, end), inner, emit) : css(text.slice(i, end), inner, emit)
      if (!m) return (js ? 'js:' : 'css:') + out
      i = end
      state = ''
      continue
    }
    if (state === 'cm') {
      const e = text.indexOf('-->', i)
      if (e < 0) {
        emit('cm', text.slice(i))
        return 'cm'
      }
      emit('cm', text.slice(i, e + 3))
      i = e + 3
      state = ''
      continue
    }
    if (state.startsWith('t:')) {
      const tag = state.slice(2)
      const c = text[i]
      const rest = text.slice(i)
      let m
      if (c === ' ' || c === '\t') {
        m = /^[ \t]+/.exec(rest)[0]
        emit('', m)
      } else if ((m = /^\/?>/.exec(rest))) {
        m = m[0]
        emit('tagp', m)
        state = m === '>' && tag === 'script' ? 'js:' : m === '>' && tag === 'style' ? 'css:' : ''
      } else if (c === '"' || c === "'") {
        const e = scanQuoted(text, i + 1, c, false)
        m = text.slice(i, e < 0 ? n : e)
        emit('str', m)
      } else if (c === '=') {
        m = c
        emit('op', c)
      } else {
        m = /^[^\s=>/"']+/.exec(rest)?.[0] || c
        emit(/^[^\s=>/"']+$/.test(m) && text[i - 1] !== '=' ? 'prop' : 'str', m)
      }
      i += m.length
      continue
    }
    const rest = text.slice(i)
    if (rest.startsWith('<!--')) {
      state = 'cm'
      continue
    }
    let m
    if ((m = /^(<\/?)([a-zA-Z][\w:-]*|!doctype|!DOCTYPE)/.exec(rest))) {
      emit('tagp', m[1])
      emit('tag', m[2])
      state = 't:' + (m[1] === '<' ? m[2].toLowerCase() : '/')
      i += m[0].length
      continue
    }
    if ((m = /^&[#\w]+;/.exec(rest))) {
      emit('num', m[0])
      i += m[0].length
      continue
    }
    m = /^[^<&]+|^[<&]/.exec(rest)[0]
    emit('', m)
    i += m.length
  }
  return state
}

function markdown(text, state, emit) {
  if (/^\s*(```|~~~)/.test(text)) {
    emit('meta', text)
    return state === 'code' ? '' : 'code'
  }
  if (state === 'code') {
    emit('str', text)
    return 'code'
  }
  if (/^#{1,6}\s/.test(text)) {
    emit('kw', text)
    return ''
  }
  if (/^\s*>/.test(text)) {
    emit('cm', text)
    return ''
  }
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]*\]\([^)]*\))|(^\s*(?:[-*+]|\d+\.)\s)/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) emit('', text.slice(last, m.index))
    emit(m[1] ? 'str' : m[2] ? 'type' : m[3] ? 'fn' : 'op', m[0])
    last = m.index + m[0].length
  }
  if (last < text.length) emit('', text.slice(last))
  return ''
}

export function tokenize(lang, text, state, emit) {
  const L = LANGS[lang] || LANGS.plaintext
  switch (L.kind) {
    case 'generic': return generic(L, text, state, emit)
    case 'css': return css(text, state, emit)
    case 'html': return html(text, state, emit)
    case 'md': return markdown(text, state, emit)
    default:
      emit('', text)
      return ''
  }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const escapeHtml = s => s.replace(/[&<>]/g, c => ESC[c])

export function highlight(lang, text, state) {
  let html = ''
  let curType = null
  let buf = ''
  const flush = () => {
    if (!buf) return
    html += curType ? `<span class="t-${curType}">${escapeHtml(buf)}</span>` : escapeHtml(buf)
    buf = ''
  }
  const end = tokenize(lang, text, state, (type, s) => {
    if (type !== curType) {
      flush()
      curType = type
    }
    buf += s
  })
  flush()
  return { html, state: end }
}

const noop = () => {}
export const endState = (lang, text, state) => tokenize(lang, text, state, noop)
