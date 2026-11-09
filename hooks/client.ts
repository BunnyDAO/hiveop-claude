import type { EngineInterface as Engine } from 'claude-code'

// The only code that talks to HiveOp. Everything takes `$` and is a top-level
// function (the engine's validator rejects helpers that close over it).
// Nothing here returns, logs or throws the key.

export const CLIENT_KIND = 'claude-code-plugin'
export const CLIENT_VERSION = '0.1.0'
const DEFAULT_API = 'https://api.wenrwa.com/api/v1'
const APPROVAL_PAGE = 'https://app.hiveop.io/claude-code'

export type Pairing = { code: string; pollToken: string; expiresAt: string; link: string }
export type PollOutcome =
  | { status: 'pending' }
  | { status: 'approved'; key: string }
  | { status: 'denied'; reason: 'denied' | 'not-open' }
  | { status: 'expired' }
  | { status: 'unreachable' }

export async function apiBase($: Engine): Promise<string> {
  const fromEnv = await $.env.get('HIVEOP_API_URL')
  return (fromEnv && /^https?:\/\//.test(fromEnv) ? fromEnv : DEFAULT_API).replace(/\/+$/, '')
}

function headers(key?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-HiveOp-Client': CLIENT_KIND,
    'X-HiveOp-Client-Version': CLIENT_VERSION,
  }
  if (key) h.Authorization = `Bearer ${key}`
  return h
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function computerName($: Engine): Promise<string> {
  try {
    const r = await $.process.run(['hostname'])
    const name = r.stdout.trim().replace(/\.local$/, '').slice(0, 80)
    return name || 'this computer'
  } catch {
    return 'this computer'
  }
}

export async function startPairing($: Engine, computer: string): Promise<Pairing | null> {
  try {
    const res = await $.http.fetch(`${await apiBase($)}/pairing/codes`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ deviceLabel: computer, purpose: 'plugin' }),
    })
    const body = parse(res.text)
    if (!res.ok || !body || typeof body.code !== 'string' || typeof body.pollToken !== 'string') return null
    return {
      code: body.code,
      pollToken: body.pollToken,
      expiresAt: String(body.expiresAt ?? ''),
      link: `${APPROVAL_PAGE}?code=${encodeURIComponent(body.code)}`,
    }
  } catch {
    return null
  }
}

export async function pollPairing($: Engine, pollToken: string): Promise<PollOutcome> {
  try {
    const res = await $.http.fetch(`${await apiBase($)}/pairing/poll`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ pollToken }),
    })
    const body = parse(res.text)
    if (!res.ok || !body) return { status: 'unreachable' }
    if (body.status === 'approved' && typeof body.connectToken === 'string') {
      return { status: 'approved', key: body.connectToken }
    }
    if (body.status === 'denied') return { status: 'denied', reason: body.reason === 'not_open' ? 'not-open' : 'denied' }
    if (body.status === 'expired') return { status: 'expired' }
    if (body.status === 'pending') return { status: 'pending' }
    return { status: 'unreachable' }
  } catch {
    return { status: 'unreachable' }
  }
}

// ── key storage: one user-only file under the home folder ──

async function keyDir($: Engine): Promise<string | null> {
  const home = await $.env.get('HOME')
  return home ? `${home}/.hiveop` : null
}

export async function loadKey($: Engine): Promise<string | null> {
  const dir = await keyDir($)
  if (!dir) return null
  try {
    const body = parse((await $.fs.read(`${dir}/claude-plugin.json`)) as string)
    return typeof body?.key === 'string' && body.key ? body.key : null
  } catch {
    return null
  }
}

export async function saveKey($: Engine, key: string): Promise<boolean> {
  const dir = await keyDir($)
  if (!dir) return false
  const file = `${dir}/claude-plugin.json`
  try {
    await $.process.run(['mkdir', '-p', '-m', '700', dir])
    // Create it user-only before the key is written, then make sure it stayed so.
    await $.process.run(['sh', '-c', 'umask 077; : >> "$1"', 'sh', file])
    await $.process.run(['chmod', '600', file])
    await $.fs.write(file, JSON.stringify({ key }))
    await $.process.run(['chmod', '600', file])
    return true
  } catch {
    return false
  }
}

export async function forgetKey($: Engine): Promise<void> {
  const dir = await keyDir($)
  if (!dir) return
  try {
    await $.process.run(['rm', '-f', `${dir}/claude-plugin.json`])
  } catch {
    // Nothing to forget.
  }
}

// ── authenticated requests ──

export type Fetched = { ok: boolean; status: number; body: Record<string, unknown> | null }

export async function hiveop($: Engine, path: string, init: { method?: string; body?: unknown } = {}): Promise<Fetched | null> {
  const key = await loadKey($)
  if (!key) return null
  try {
    const res = await $.http.fetch(`${await apiBase($)}${path}`, {
      method: init.method ?? 'GET',
      headers: headers(key),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return { ok: res.ok, status: res.status, body: parse(res.text) }
  } catch {
    return { ok: false, status: 0, body: null }
  }
}

/** The signed-in person's display name; null when they have none. */
export type Me = { state: 'ok'; name: string | null } | { state: 'rejected' } | { state: 'unreachable' }

export async function fetchMe($: Engine): Promise<Me> {
  const r = await hiveop($, '/me/hive/profile')
  if (!r || r.status === 0) return { state: 'unreachable' }
  if (r.status === 401 || r.status === 403) return { state: 'rejected' }
  if (!r.ok) return { state: 'unreachable' }
  const profile = r.body?.profile as { displayName?: unknown } | undefined
  const name = typeof profile?.displayName === 'string' && profile.displayName.trim() ? profile.displayName.trim() : null
  return { state: 'ok', name }
}
