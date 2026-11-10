import type { EngineInterface as Engine } from 'claude-code'

// hcp-22: find a workspace's clone on this computer and open Claude Code there
// in a new terminal tab. Top-level functions that take `$` (the validator
// rejects helpers that close over it). Folder paths stay on this machine.

const STORE_CLONES = 'clones.byRemote'
const STORE_OPEN = 'join.open'
const OPEN_TTL_MS = 2 * 60_000
const SCAN_CAP = 40

/** "host/owner/repo" for any ssh or https spelling of a git remote; '' when it is not one. */
export function normRemote(url: string): string {
  let u = url.trim()
  if (!u) return ''
  let host = ''
  let path = ''
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    host = scp[1]!
    path = scp[2]!
  } else {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u)
    if (!m) return ''
    host = m[1]!
    path = m[2]!
  }
  path = path.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '')
  if (!host || !path.includes('/')) return ''
  return `${host}/${path}`.toLowerCase()
}

function hasControl(t: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(t)
}

function shq(t: string): string {
  return `'${t.replace(/'/g, `'\\''`)}'`
}

/** The one-line command that does what Open does: copyable. */
export function claudeCommand(dir: string, pluginDir: string | null): string {
  return `cd ${shq(dir)} && claude${pluginDir ? ` --plugin-dir ${shq(pluginDir)}` : ''}`
}

function asq(t: string): string {
  return t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** The host command that opens a new tab running Claude Code in `dir`, per terminal; null when the terminal is unknown. */
export function launchArgv(term: string, dir: string, pluginDir: string | null): string[] | null {
  const claude = ['claude', ...(pluginDir ? ['--plugin-dir', pluginDir] : [])]
  const line = asq(claudeCommand(dir, pluginDir))
  switch (term) {
    case 'Apple_Terminal':
      return ['osascript', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script "${line}"`, '-e', 'end tell']
    case 'iTerm.app':
      return [
        'osascript',
        '-e', 'tell application "iTerm"',
        '-e', 'activate',
        '-e', 'if (count of windows) = 0 then',
        '-e', 'create window with default profile',
        '-e', 'else',
        '-e', 'tell current window to create tab with default profile',
        '-e', 'end if',
        '-e', `tell current session of current window to write text "${line}"`,
        '-e', 'end tell',
      ]
    case 'ghostty':
      return ['open', '-na', 'Ghostty', '--args', `--working-directory=${dir}`, '-e', ...claude]
    case 'WezTerm':
      return ['wezterm', 'cli', 'spawn', '--cwd', dir, '--', ...claude]
    case 'kitty':
      return ['kitten', '@', 'launch', '--type=tab', '--cwd', dir, ...claude]
    default:
      return null
  }
}

/** Installed plugins live under ~/.claude/plugins; anywhere else means this session was started with --plugin-dir. */
export function inlinePluginDir(root: string, home: string): string | null {
  if (!root) return null
  const installed = `${home}/.claude/plugins/`
  return home && root.startsWith(installed) ? null : root
}

// ── remembered folders ──

async function readMap($: Engine, key: string): Promise<Record<string, unknown>> {
  try {
    const v = await $.store.get(key)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Remember that this folder is the clone of `remote`. */
export async function rememberClone($: Engine, remote: string, dir: string): Promise<void> {
  const k = normRemote(remote)
  if (!k || !dir || hasControl(dir)) return
  const map = await readMap($, STORE_CLONES)
  if (map[k] === dir) return
  await $.store.set(STORE_CLONES, { ...map, [k]: dir })
}

async function originOf($: Engine, dir: string): Promise<string> {
  try {
    const r = await $.process.run(['git', '-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: 5000 })
    return r.exitCode === 0 ? normRemote(r.stdout) : ''
  } catch {
    return ''
  }
}

async function subfolders($: Engine, parent: string): Promise<string[]> {
  try {
    const entries = await $.fs.list(parent)
    return entries
      .filter((e) => e.kind === 'dir' && !e.name.startsWith('.') && !hasControl(e.name))
      .map((e) => `${parent.replace(/\/+$/, '')}/${e.name}`)
      .slice(0, SCAN_CAP)
  } catch {
    return []
  }
}

/**
 * Every clone this computer is known to hold: remote → folder. Looks in folders
 * remembered from earlier joins, ~/HiveOp/*, and the session folder's siblings,
 * and trusts only what `git remote get-url origin` says.
 */
export async function scanClones($: Engine, cwd: string, home: string): Promise<Record<string, string>> {
  const remembered = await readMap($, STORE_CLONES)
  const candidates: string[] = []
  for (const d of Object.values(remembered)) if (typeof d === 'string') candidates.push(d)
  if (home) candidates.push(...(await subfolders($, `${home}/HiveOp`)))
  const parent = cwd.replace(/\/+$/, '').replace(/\/[^/]*$/, '')
  if (parent && parent !== cwd) candidates.push(...(await subfolders($, parent)))
  if (cwd) candidates.push(cwd)
  const found: Record<string, string> = {}
  const seen = new Set<string>()
  for (const dir of candidates) {
    if (seen.has(dir) || hasControl(dir) || !dir.startsWith('/')) continue
    seen.add(dir)
    const k = await originOf($, dir)
    if (k && !found[k]) found[k] = dir
  }
  return found
}

// ── join on open: a one-shot note to the session about to start ──

export async function writeJoinOnOpen($: Engine, folderKey: string, workspaceId: string): Promise<void> {
  const now = await $.clock.now()
  const map = await readMap($, STORE_OPEN)
  const live: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(map)) {
    const exp = (v as { exp?: unknown } | null)?.exp
    if (typeof exp === 'number' && exp > now) live[k] = v
  }
  live[folderKey] = { ws: workspaceId, exp: now + OPEN_TTL_MS }
  await $.store.set(STORE_OPEN, live)
}

/** The workspace this folder was opened to join, if the note is fresh. Always removes the folder's note. */
export async function takeJoinOnOpen($: Engine, folderKey: string): Promise<string | null> {
  const map = await readMap($, STORE_OPEN)
  const rec = map[folderKey] as { ws?: unknown; exp?: unknown } | undefined
  if (!rec) return null
  const { [folderKey]: _gone, ...rest } = map
  await $.store.set(STORE_OPEN, rest)
  const now = await $.clock.now()
  return typeof rec.ws === 'string' && typeof rec.exp === 'number' && rec.exp > now ? rec.ws : null
}

// ── open ──

export type Opened = { ok: true } | { ok: false; command: string }

/** Open Claude Code in `dir` in a new terminal tab, or hand back the command to copy. */
export async function openFolder($: Engine, dir: string, pluginDir: string | null, canLaunch: boolean): Promise<Opened> {
  const command = claudeCommand(dir, pluginDir)
  if (!canLaunch || hasControl(dir)) return { ok: false, command }
  const term = (await $.env.get('TERM_PROGRAM')) ?? ''
  const argv = launchArgv(term, dir, pluginDir)
  if (!argv) return { ok: false, command }
  try {
    const r = await $.process.run(argv, { timeoutMs: 8000 })
    return r.exitCode === 0 ? { ok: true } : { ok: false, command }
  } catch {
    return { ok: false, command }
  }
}

// ── get code (hcp-23): clone with the person's own git access; HiveOp mints nothing ──

/** A folder name for a workspace: lowercase letters, digits and dashes. */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '')
  return s || 'workspace'
}

/** Only plain ssh or https remotes, with no secret in the address itself. */
export function cloneableUrl(url: string): boolean {
  const u = url.trim()
  if (!u || hasControl(u) || u.startsWith('-') || !normRemote(u)) return false
  if (/^https?:\/\/[^/]*@/i.test(u)) return false
  return /^(https?:\/\/|ssh:\/\/|[^@/\s]+@[^:/\s]+:)/i.test(u)
}

/** The percentage in a piece of git's --progress output (it rewrites one line with \r); null when none. */
export function lastPercent(text: string): number | null {
  const all = [...text.matchAll(/(\d{1,3})%/g)]
  const last = all[all.length - 1]
  if (!last) return null
  const n = Number(last[1])
  return n >= 0 && n <= 100 ? n : null
}

/** One line for a failed clone, from git's stderr. The output itself is never shown: it can carry credentialed URLs. */
export function cloneFailureLine(stderr: string): string {
  // The credential helper's own fixed words (hcp-26); nothing else of git's output is read for meaning beyond this.
  if (/hiveop-git-credential: revoked/.test(stderr)) return 'Repo access revoked.'
  return /authentication failed|could not read (?:username|password)|permission denied|repository not found|not found|access denied|terminal prompts disabled|\b40[134]\b|publickey/i.test(stderr)
    ? 'No GitHub access to this repo.'
    : 'Clone failed.'
}

export type CloneTarget = { dir: string; existing: boolean }

/** ~/HiveOp/<slug>, then -2, -3 ... when that folder is another repo. A folder that already is this repo is found. */
export async function chooseCloneFolder($: Engine, home: string, name: string, repoUrl: string): Promise<CloneTarget> {
  const want = normRemote(repoUrl)
  const base = `${home.replace(/\/+$/, '')}/HiveOp/${slugify(name)}`
  for (let n = 1; n < 100; n++) {
    const dir = n === 1 ? base : `${base}-${n}`
    try {
      await $.fs.list(dir)
    } catch {
      return { dir, existing: false }
    }
    if ((await originOf($, dir)) === want) return { dir, existing: true }
  }
  return { dir: `${base}-${Date.now()}`, existing: false }
}

export type Cloned = { ok: true } | { ok: false; reason: string }

/** "https://host[:port]" of an https remote: the scope git matches `credential.<origin>.helper` against. '' when not https. */
export function httpsOrigin(url: string): string {
  const m = /^https:\/\/([^/@:\s]+(?::\d+)?)(?:\/|$)/i.exec(url.trim())
  return m ? `https://${m[1]!.toLowerCase()}` : ''
}

/**
 * The git credential helper for a HiveOp cloud repo: a script shipped in this plugin that asks the HiveOp API
 * for a fresh token each time. Only the script path, the API address and the workspace id are named here;
 * it reads the key itself. Run through `sh`, so the file needs no executable bit. '' when anything is unsafe.
 */
export function helperValue(pluginRoot: string, api: string, wsId: string): string {
  if (!pluginRoot || hasControl(pluginRoot) || !/^https?:\/\/[A-Za-z0-9:/._-]+$/.test(api) || !/^[A-Za-z0-9-]+$/.test(wsId)) return ''
  return `!sh ${shq(`${pluginRoot.replace(/\/+$/, '')}/bin/hiveop-git-credential`)} ${shq(api)} ${shq(wsId)}`
}

/** `-c` pairs that reset any other helper for this origin (so no stored login is used or written), then name ours. */
export function helperFlags(origin: string, helper: string): string[] {
  return ['-c', `credential.${origin}.helper=`, '-c', `credential.${origin}.helper=${helper}`]
}

/** Pin the helper into the clone's own config, so pull and push use it the same way. Nothing secret is written. */
export async function pinHelper($: Engine, dir: string, origin: string, helper: string): Promise<boolean> {
  try {
    const key = `credential.${origin}.helper`
    const a = await $.process.run(['git', '-C', dir, 'config', '--local', '--add', key, ''], { timeoutMs: 5000 })
    const b = await $.process.run(['git', '-C', dir, 'config', '--local', '--add', key, helper], { timeoutMs: 5000 })
    return a.exitCode === 0 && b.exitCode === 0
  } catch {
    return false
  }
}

/**
 * git clone --progress into `dir`; `onPercent` hears each step. Failure comes back as one safe line.
 * With a `helper` (HiveOp cloud repos) git gets its credential from that helper: the address stays plain.
 */
export async function cloneRepo($: Engine, repoUrl: string, dir: string, onPercent: (n: number) => void, helper?: { origin: string; value: string }): Promise<Cloned> {
  if (!cloneableUrl(repoUrl) || hasControl(dir)) return { ok: false, reason: 'Clone failed.' }
  if (helper && (!helper.origin || !helper.value || httpsOrigin(repoUrl) !== helper.origin)) return { ok: false, reason: 'Clone failed.' }
  let tail = ''
  try {
    const pre = helper ? helperFlags(helper.origin, helper.value) : []
    const run = $.process.spawn({ argv: ['git', ...pre, 'clone', '--progress', '--', repoUrl.trim(), dir], env: { GIT_TERMINAL_PROMPT: '0' } })
    let code: number | null = null
    while (true) {
      const step = await run.next()
      if (step.done) {
        code = step.value.code
        break
      }
      if (step.value.stream !== 'stderr') continue
      tail = (tail + step.value.text).slice(-2000)
      const p = lastPercent(step.value.text)
      if (p !== null) onPercent(p)
    }
    return code === 0 ? { ok: true } : { ok: false, reason: cloneFailureLine(tail) }
  } catch {
    return { ok: false, reason: 'Clone failed.' }
  }
}

/**
 * Local workspaces on this computer: the HiveOp bridge's own map
 * (~/.wen-market/local-workspaces.json, folder → workspace). Workspace id → folder.
 * Missing, unreadable or unknown-shaped file: none. Paths stay on this machine.
 */
export async function readLocalFolders($: Engine, home: string): Promise<Record<string, string>> {
  if (!home) return {}
  let raw: unknown
  try {
    raw = JSON.parse(String(await $.fs.read(`${home}/.wen-market/local-workspaces.json`)))
  } catch {
    return {}
  }
  const r = raw as { v?: unknown; entries?: unknown }
  if (!r || r.v !== 1 || !r.entries || typeof r.entries !== 'object' || Array.isArray(r.entries)) return {}
  const out: Record<string, string> = {}
  for (const [folder, e] of Object.entries(r.entries as Record<string, unknown>)) {
    const id = (e as { workspaceId?: unknown } | null)?.workspaceId
    const dir = folder.replace(/\/+$/, '')
    if (typeof id !== 'string' || !id || !dir.startsWith('/') || hasControl(dir) || hasControl(id)) continue
    out[id] = dir
  }
  return out
}

/** The local workspace whose folder holds `cwd` (deepest folder wins); null when none. */
export function localWorkspaceAt(folders: Record<string, string>, cwd: string): string | null {
  const here = cwd.replace(/\/+$/, '')
  let best: { id: string; len: number } | null = null
  for (const [id, dir] of Object.entries(folders)) {
    if ((here === dir || here.startsWith(`${dir}/`)) && (!best || dir.length > best.len)) best = { id, len: dir.length }
  }
  return best?.id ?? null
}
