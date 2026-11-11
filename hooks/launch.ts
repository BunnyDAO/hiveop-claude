import type { EngineInterface as Engine } from 'claude-code'

// hcp-22: find a workspace's clone on this computer and open Claude Code there
// in a new terminal tab. Top-level functions that take `$` (the validator
// rejects helpers that close over it). Folder paths stay on this machine.

export const STORE_CLONES = 'clones.byRemote'

export const STORE_OPEN = 'join.open'

export const OPEN_TTL_MS = 2 * 60_000

export const SCAN_CAP = 40

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

export function hasControl(t: string): boolean {
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

export type Opened = { ok: true } | { ok: false; command: string }

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

/** The local workspace whose folder holds `cwd` (deepest folder wins); null when none. */
export function localWorkspaceAt(folders: Record<string, string>, cwd: string): string | null {
  const here = cwd.replace(/\/+$/, '')
  let best: { id: string; len: number } | null = null
  for (const [id, dir] of Object.entries(folders)) {
    if ((here === dir || here.startsWith(`${dir}/`)) && (!best || dir.length > best.len)) best = { id, len: dir.length }
  }
  return best?.id ?? null
}
