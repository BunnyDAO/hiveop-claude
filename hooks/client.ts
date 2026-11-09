import type { EngineInterface as Engine } from 'claude-code'

import type { InviteRow, PilotRow, WsRow } from '../types'

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

export type Fetched = { ok: boolean; status: number; body: Record<string, unknown> | null; retryAfterSec: number | null }

function retryAfter(h: Record<string, string> | undefined): number | null {
  if (!h) return null
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === 'retry-after') {
      const n = Number(h[k])
      return Number.isFinite(n) && n >= 0 ? Math.min(Math.ceil(n), 3600) : null
    }
  }
  return null
}

export async function hiveop($: Engine, path: string, init: { method?: string; body?: unknown } = {}): Promise<Fetched | null> {
  const key = await loadKey($)
  if (!key) return null
  try {
    const res = await $.http.fetch(`${await apiBase($)}${path}`, {
      method: init.method ?? 'GET',
      headers: headers(key),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return { ok: res.ok, status: res.status, body: parse(res.text), retryAfterSec: retryAfter(res.headers) }
  } catch {
    return { ok: false, status: 0, body: null, retryAfterSec: null }
  }
}

/** The signed-in person's display name; null when they have none. */
export type Me = { state: 'ok'; name: string | null; wallet: string | null } | { state: 'rejected' } | { state: 'unreachable' }

export async function fetchMe($: Engine): Promise<Me> {
  const r = await hiveop($, '/me/hive/profile')
  if (!r || r.status === 0) return { state: 'unreachable' }
  if (r.status === 401 || r.status === 403) return { state: 'rejected' }
  if (!r.ok) return { state: 'unreachable' }
  const profile = r.body?.profile as { displayName?: unknown; walletPubkey?: unknown } | undefined
  const name = typeof profile?.displayName === 'string' && profile.displayName.trim() ? profile.displayName.trim() : null
  const wallet = typeof profile?.walletPubkey === 'string' && profile.walletPubkey ? profile.walletPubkey : null
  return { state: 'ok', name, wallet }
}

/**
 * One person's 64px photo as base64 PNG bytes, or null (no photo, not visible, blocked, offline).
 * The host's fetch is text-only, so the server sends base64 text (?encoding=base64).
 */
export async function fetchAvatar($: Engine, wallet: string): Promise<string | null> {
  const key = await loadKey($)
  if (!key) return null
  try {
    const res = await $.http.fetch(`${await apiBase($)}/users/${encodeURIComponent(wallet)}/avatar.png?encoding=base64`, { headers: headers(key) })
    const text = res.text.trim()
    return res.ok && text.length > 0 && text.length <= 60_000 && /^[A-Za-z0-9+/]+=*$/.test(text) ? text : null
  } catch {
    return null
  }
}

// ── workspaces and people (hcp-10) ──


function s(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** The server's own words for a refusal, plainly; else a short fallback. */
export function refusal(r: Fetched | null): string {
  if (!r) return 'Sign in first.'
  if (r.status === 0) return "Couldn't reach HiveOp."
  const err = r.body?.error as { message?: unknown } | undefined
  const said = s(err?.message).trim()
  if (said) return said.slice(0, 200)
  if (r.status === 401) return 'HiveOp no longer accepts this sign-in.'
  if (r.status === 429) return `Slow down — try again in ${r.retryAfterSec ?? 30}s.`
  return 'That did not work. Try again.'
}

function wsRow(raw: unknown): WsRow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const id = s(w.id)
  if (!id) return null
  const caps = (w.capabilities && typeof w.capabilities === 'object' ? w.capabilities : {}) as Record<string, unknown>
  return {
    id,
    name: s(w.name).trim() || s(w.title).trim() || 'workspace',
    kind: s(w.kind),
    members: typeof w.memberCount === 'number' ? w.memberCount : null,
    canJoin: caps.canJoin === true,
  }
}

export async function listMine($: Engine): Promise<{ rows: WsRow[] } | { fail: Fetched | null }> {
  const r = await hiveop($, '/workspaces')
  if (!r || !r.ok) return { fail: r }
  const list = Array.isArray(r.body?.workspaces) ? (r.body!.workspaces as unknown[]) : []
  return { rows: list.map(wsRow).filter((x): x is WsRow => x !== null) }
}

export async function listInvites($: Engine): Promise<{ rows: InviteRow[] } | { fail: Fetched | null }> {
  const r = await hiveop($, '/me/invites')
  if (!r || !r.ok) return { fail: r }
  const list = Array.isArray(r.body?.invites) ? (r.body!.invites as Array<Record<string, unknown>>) : []
  const rows: InviteRow[] = []
  for (const x of list) {
    const inv = (x.invite && typeof x.invite === 'object' ? x.invite : {}) as Record<string, unknown>
    const ws = (x.workspace && typeof x.workspace === 'object' ? x.workspace : {}) as Record<string, unknown>
    if (s(inv.id) && s(inv.token)) rows.push({ id: s(inv.id), token: s(inv.token), wsId: s(ws.id), wsName: s(ws.name).trim() || 'workspace' })
  }
  return { rows }
}

export async function acceptInvite($: Engine, token: string): Promise<Fetched | null> {
  return hiveop($, `/workspaces/invites/${encodeURIComponent(token)}/redeem`, { method: 'POST' })
}

export async function declineInvite($: Engine, inviteId: string): Promise<Fetched | null> {
  return hiveop($, '/me/invites/decline', { method: 'POST', body: { inviteId } })
}

export async function listExplore(
  $: Engine,
  search: string,
  offset: number,
  limit: number,
): Promise<{ rows: WsRow[]; total: number } | { fail: Fetched | null }> {
  const q = `limit=${limit}&offset=${offset}${search ? `&search=${encodeURIComponent(search)}` : ''}`
  const r = await hiveop($, `/workspaces/explore?${q}`)
  if (!r || !r.ok) return { fail: r }
  const list = Array.isArray(r.body?.workspaces) ? (r.body!.workspaces as unknown[]) : []
  const rows = list.map(wsRow).filter((x): x is WsRow => x !== null)
  return { rows, total: typeof r.body?.total === 'number' ? r.body.total : offset + rows.length }
}

/** Open join. Resolves with the server's reply; `visiting` when the join is a visit, not a membership. */
export async function joinWorkspace($: Engine, id: string): Promise<Fetched | null> {
  return hiveop($, `/workspaces/${encodeURIComponent(id)}/join`, { method: 'POST' })
}

export async function requestToJoin($: Engine, id: string): Promise<Fetched | null> {
  return hiveop($, `/workspaces/${encodeURIComponent(id)}/join-requests`, { method: 'POST', body: {} })
}

export async function listPilots($: Engine, query: string, offset: number, limit: number): Promise<{ rows: PilotRow[] } | { fail: Fetched | null }> {
  const q = `limit=${limit}&offset=${offset}${query ? `&query=${encodeURIComponent(query)}` : ''}`
  const r = await hiveop($, `/pilots?${q}`)
  if (!r || !r.ok) return { fail: r }
  const list = Array.isArray(r.body?.pilots) ? (r.body!.pilots as Array<Record<string, unknown>>) : []
  return { rows: list.filter((p) => s(p.wallet) && s(p.displayName)).map((p) => ({ wallet: s(p.wallet), name: s(p.displayName).trim() })) }
}

export async function followingAmong($: Engine, wallets: string[]): Promise<string[] | null> {
  if (wallets.length === 0) return []
  const r = await hiveop($, '/me/following/among', { method: 'POST', body: { wallets } })
  if (!r || !r.ok || !Array.isArray(r.body?.following)) return null
  return (r.body!.following as unknown[]).filter((w): w is string => typeof w === 'string')
}

export async function setFollow($: Engine, wallet: string, on: boolean): Promise<Fetched | null> {
  return hiveop($, `/users/${encodeURIComponent(wallet)}/follow`, { method: on ? 'POST' : 'DELETE' })
}

// ── work (hcp-11) ──

export type WorkSummary = { ready: number; inProgress: number; next: { id: string; title: string } | null }

export async function fetchWorkSummary($: Engine, wsId: string): Promise<{ summary: WorkSummary } | { fail: Fetched | null }> {
  const r = await hiveop($, `/workspaces/${encodeURIComponent(wsId)}/work-summary`)
  if (!r || !r.ok || !r.body) return { fail: r }
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
  const nx = r.body.next as { id?: unknown; title?: unknown } | null | undefined
  const next = nx && s(nx.id) ? { id: s(nx.id), title: s(nx.title).trim() || 'untitled' } : null
  return { summary: { ready: n(r.body.ready), inProgress: n(r.body.inProgress), next } }
}

/** Claim as the person. The server's one-at-a-time rule and its words come back in `refusal`. */
export async function claimIssue($: Engine, wsId: string, issueId: string): Promise<Fetched | null> {
  return hiveop($, `/workspaces/${encodeURIComponent(wsId)}/issues/${encodeURIComponent(issueId)}/claim`, { method: 'POST' })
}

// ── adopted sessions (hcp-15) ──

/** The folder's `origin` remote, or null when it has none. Never logged: it can carry a name. */
export async function gitRemote($: Engine, cwd: string): Promise<string | null> {
  try {
    const r = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd })
    const url = r.stdout.trim()
    return r.exitCode === 0 && url ? url : null
  } catch {
    return null
  }
}

/** An opaque stand-in for the folder (two FNV-1a passes, 16 hex): the path itself never leaves the machine. */
export function folderKey(cwd: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < cwd.length; i++) {
    const c = cwd.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

export type Matched = { mine: Array<{ id: string; name: string }>; joinable: Array<{ id: string; name: string }> }

export async function matchWorkspaces($: Engine, remote: string): Promise<Matched | null> {
  const r = await hiveop($, `/me/workspaces/match?remote=${encodeURIComponent(remote)}`)
  if (!r || !r.ok || !r.body) return null
  const rows = (v: unknown): Array<{ id: string; name: string }> =>
    Array.isArray(v)
      ? (v as Array<Record<string, unknown>>).filter((x) => s(x?.id)).map((x) => ({ id: s(x.id), name: s(x.name).trim() || 'workspace' }))
      : []
  return { mine: rows(r.body.mine), joinable: rows(r.body.joinable) }
}

export type Adopted = { agentId: string; name: string; resumed: boolean }

export async function adoptSession($: Engine, wsId: string, folder: string, session: string): Promise<{ seat: Adopted } | { fail: Fetched | null }> {
  const r = await hiveop($, `/workspaces/${encodeURIComponent(wsId)}/adopted-sessions`, { method: 'POST', body: { folderKey: folder, sessionKey: session } })
  if (!r || !r.ok || !r.body || !s(r.body.agentId)) return { fail: r }
  return { seat: { agentId: s(r.body.agentId), name: s(r.body.name).trim() || 'Claude Code', resumed: r.body.resumed === true } }
}

export async function leaveSession($: Engine, wsId: string, agentId: string): Promise<Fetched | null> {
  return hiveop($, `/workspaces/${encodeURIComponent(wsId)}/adopted-sessions/${encodeURIComponent(agentId)}/offline`, { method: 'POST' })
}
