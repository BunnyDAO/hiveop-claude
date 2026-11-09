// Key guard (hcp-13): refuses the session's own tool calls that would read or
// leak the Plugin key. Best effort, not a wall (see docs/security.md).
//
// The key sits in ~/.hiveop/claude-plugin.json. A prompt-injected agent could
// read it with its own tools; this refuses the obvious ways. Git reaches the key
// through bin/hiveop-git-credential, which git runs itself, so ordinary
// `git push` / `git pull` text never matches.

export const KEY_REFUSAL = 'HiveOp blocks reading its sign-in key.'

const KEY_DIR = '.hiveop'
const KEY_FILE = 'claude-plugin.json'
const HELPER = 'hiveop-git-credential'
const FILE_FIELDS = ['file_path', 'path', 'notebook_path', 'glob', 'pattern']

function globToRegExp(glob: string): RegExp | null {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end < 0) return null
      re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
      i = end
    } else if (c === '{') {
      const end = glob.indexOf('}', i + 1)
      if (end < 0) return null
      re += `(?:${glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|\\[\]{}*?]/g, '\\$&')).join('|')})`
      i = end
    } else re += c.replace(/[.+^$()|\\\]}]/g, '\\$&')
  }
  try {
    return new RegExp(`^${re}$`)
  } catch {
    return null
  }
}

const hasGlob = (s: string) => /[*?[{]/.test(s)

// Does one path segment name the key folder or file, literally or as a glob?
function segmentHits(seg: string): boolean {
  if (seg === KEY_DIR || seg === KEY_FILE) return true
  if (!hasGlob(seg)) return false
  // A bare wildcard is not a reference; it needs some letters of the name.
  if (seg.replace(/[*?[\]{}!,]/g, '').length < 3) return false
  const re = globToRegExp(seg)
  return !!re && (re.test(KEY_DIR) || re.test(KEY_FILE))
}

// Spell a path out: ~, $HOME, ${HOME}, //, /./ and .. all resolved.
function normalize(raw: string, home: string, cwd = ''): string {
  let p = raw.replace(/\$\{HOME\}|\$HOME/g, home)
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1)
  if (!p.startsWith('/')) p = `${cwd}/${p}`
  const out: string[] = []
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return `/${out.join('/')}`
}

function pathHitsKey(raw: string, home: string): boolean {
  if (!raw) return false
  const abs = normalize(raw, home, home + '/__cwd__')
  const h = home.replace(/\/+$/, '')
  // Anything under the home folder whose first segment names the key folder.
  if (abs === h || abs.startsWith(`${h}/`)) {
    const rest = abs.slice(h.length + 1).split('/')
    if (rest[0] && segmentHits(rest[0]) && rest[0] !== KEY_FILE) return true
  }
  // The key file by name, wherever it is searched for.
  return abs.split('/').some((s) => s === KEY_FILE || (hasGlob(s) && segmentHits(s) && s !== KEY_DIR && !!globToRegExp(s)?.test(KEY_FILE)))
}

// Strip quoting that would split a name apart: .hiv"eop", .hi\veop.
function unquote(cmd: string): string {
  return cmd.replace(/\\\n/g, '').replace(/["'\\]/g, '')
}

export function bashHitsKey(command: string, home: string): boolean {
  const cmd = unquote(command)
  if (cmd.includes(HELPER)) return true
  if (/\bgit\s+(?:-\S+\s+)*credential\s+(?:fill|approve|reject)\b/.test(cmd)) return true
  const h = home.replace(/\/+$/, '')
  const tokens = cmd.split(/[\s;&|<>()`=]+/).filter(Boolean)
  for (const tok of tokens) {
    if (tok.includes(KEY_FILE)) return true
    // A path word: normalise it (home forms resolved) and test it like a file path.
    if (/^(~|\$\{?HOME\}?|\/)/.test(tok) || tok.includes(`/${KEY_DIR}`) || tok.startsWith(KEY_DIR)) {
      const underHome = /^(~|\$\{?HOME\}?)/.test(tok) || tok.startsWith(`${h}/`) || tok === h
      if (underHome && pathHitsKey(tok, home)) return true
    }
    // Relative or expression spelling: HOME+'/.hiveop/...', process.env.HOME + ...
    if (new RegExp(`(?:HOME|~|${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[^\\s]{0,6}/${KEY_DIR}(?:/|$)`).test(tok)) return true
  }
  // Any hidden name right after a home spelling, literal or glob (~/.hive*, ~/.h*op).
  const homeEsc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const afterHome = new RegExp(`(?:~|\\$\\{?HOME\\}?|${homeEsc})/+(?:\\./+)*(\\.[^/\\s]*)`, 'g')
  return [...cmd.matchAll(afterHome)].some((m) => segmentHits(m[1]!))
}

// The reason a tool call is refused, or null when it may run.
export function keyGuardReason(e: Record<string, unknown>, home: string | null | undefined): string | null {
  if (!home) return null
  const tool = String(e.tool ?? '')
  if (tool.startsWith('mcp__')) return null
  if (tool === 'Bash') {
    return typeof e.command === 'string' && bashHitsKey(e.command, home) ? KEY_REFUSAL : null
  }
  for (const f of FILE_FIELDS) {
    const v = e[f]
    if (typeof v === 'string' && pathHitsKey(v, home)) return KEY_REFUSAL
  }
  // A search rooted at the home folder with a glob into the key folder.
  const root = typeof e.path === 'string' ? e.path : ''
  for (const f of ['glob', 'pattern']) {
    const v = e[f]
    if (typeof v === 'string' && root && pathHitsKey(`${root}/${v}`, home)) return KEY_REFUSAL
  }
  return null
}
