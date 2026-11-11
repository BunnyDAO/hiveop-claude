import type { EngineInterface as Engine } from 'claude-code'

import type { CloudAgent, InviteRow, PilotRow, WsRow } from '../types'

// The only code that talks to HiveOp. Everything takes `$` and is a top-level
// function (the engine's validator rejects helpers that close over it).
// Nothing here returns, logs or throws the key.

export const CLIENT_KIND = 'claude-code-plugin'

export const CLIENT_VERSION = '0.2.1'

export const DEFAULT_API = 'https://api.wenrwa.com/api/v1'

export const APPROVAL_PAGE = 'https://app.hiveop.io/claude-code'

export type Pairing = { code: string; pollToken: string; expiresAt: string; link: string }

export type PollOutcome =
  | { status: 'pending' }
  | { status: 'approved'; key: string }
  | { status: 'denied'; reason: 'denied' | 'not-open' }
  | { status: 'expired' }
  | { status: 'unreachable' }

export function headers(key?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-HiveOp-Client': CLIENT_KIND,
    'X-HiveOp-Client-Version': CLIENT_VERSION,
  }
  if (key) h.Authorization = `Bearer ${key}`
  return h
}

export function parse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export type Fetched = { ok: boolean; status: number; body: Record<string, unknown> | null; retryAfterSec: number | null }

export function retryAfter(h: Record<string, string> | undefined): number | null {
  if (!h) return null
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === 'retry-after') {
      const n = Number(h[k])
      return Number.isFinite(n) && n >= 0 ? Math.min(Math.ceil(n), 3600) : null
    }
  }
  return null
}

// ── hcp-02: the client gate ──

/** HiveOp refuses this version (too old) or has paused the plugin. */
export type Gate = { why: 'update' | 'paused'; message: string | null }

/** The gate refusal in a keyed reply, if it is one. */
export function gateOf(status: number, body: Record<string, unknown> | null): Gate | null {
  const err = body?.error as { code?: unknown; message?: unknown } | undefined
  const message = typeof err?.message === 'string' && err.message.trim() ? err.message.trim().slice(0, 140) : null
  if (status === 426 && err?.code === 'CLIENT_UPDATE_REQUIRED') return { why: 'update', message }
  if (status === 503 && err?.code === 'CLIENT_PAUSED') return { why: 'paused', message }
  return null
}

/** The signed-in person's display name; null when they have none. */
export type Me = { state: 'ok'; name: string | null; wallet: string | null } | { state: 'rejected' } | { state: 'unreachable' }

export function s(v: unknown): string {
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

export function wsRow(raw: unknown): WsRow | null {
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
    repoUrl: s(w.githubRepoUrl).trim(),
  }
}

export type WorkSummary = { ready: number; inProgress: number; next: { id: string; title: string } | null }

export type WorkItem = { id: string; title: string; description: string; priority: string | null }

export function toItem(raw: unknown): WorkItem | null {
  const o = raw as Record<string, unknown> | null
  if (!o || !s(o.id)) return null
  return {
    id: s(o.id),
    title: s(o.title).trim() || 'untitled',
    description: s(o.description).trim().slice(0, 4000),
    priority: s(o.priority) || null,
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

export type Adopted = { agentId: string; name: string; resumed: boolean }

const APP = 'https://app.hiveop.io'

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired'

/** Where the person approves a filed request. */
export function approvalUrl(id: string): string {
  return `${APPROVAL_PAGE}/approve?id=${encodeURIComponent(id)}`
}

/** The workspace in the app, where its agents and terminals are. */
export function workspaceUrl(wsId: string): string {
  return `${APP}/hive/${encodeURIComponent(wsId)}`
}
