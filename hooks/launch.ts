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
