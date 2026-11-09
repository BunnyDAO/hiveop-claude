import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface as Engine, Register } from 'claude-code'

import type { AuthView, ChatMsg, ChatTab, ChatView, InviteRow, NavView, PhotosView, PilotRow, SeatView, WorkView, WsRow } from '../types'
import {
  type Fetched,
  acceptInvite,
  adoptSession,
  claimIssue,
  computerName,
  declineInvite,
  fetchWorkSummary,
  fetchMe,
  folderKey,
  fetchAvatar,
  followingAmong,
  forgetKey,
  gitRemote,
  hiveop,
  joinWorkspace,
  leaveSession,
  listExplore,
  listInvites,
  listMine,
  listPilots,
  loadKey,
  matchWorkspaces,
  pollPairing,
  refusal,
  requestToJoin,
  saveKey,
  setFollow,
  startPairing,
} from './client'
import { chooseCloneFolder, cloneRepo, cloneableUrl, inlinePluginDir, normRemote, openFolder, rememberClone, scanClones, takeJoinOnOpen, writeJoinOnOpen } from './launch'

const EMPTY_CHAT: ChatView = {
  workspace: null,
  tabs: [],
  status: 'loading',
  screen: 'home',
  messages: [],
  unread: 0,
  firstNewId: null,
  draft: '',
  me: null,
  send: { phase: 'idle' },
}
const auth = atom({ plugin: 'hiveop', key: 'auth' } as const, { phase: 'signed-out' } as AuthView, { shape: 'auth-1' })
const chat = atom({ plugin: 'hiveop', key: 'chat' } as const, EMPTY_CHAT, { shape: 'chat-3' })
const EMPTY_PHOTOS: PhotosView = { byWallet: {} }
const photos = atom({ plugin: 'hiveop', key: 'photos' } as const, EMPTY_PHOTOS, { shape: 'photos-1' })
const EMPTY_NAV: NavView = {
  screen: 'home',
  tab: 'mine',
  band: 'shown',
  note: '',
  mine: null,
  invites: null,
  explore: { search: '', rows: [], offset: 0, total: 0, loaded: false },
  people: { query: '', rows: [], following: [], offset: 0, more: false, loaded: false },
  clones: {},
}
const nav = atom({ plugin: 'hiveop', key: 'nav' } as const, EMPTY_NAV, { shape: 'nav-3' })
const EMPTY_WORK: WorkView = { workspaceId: null, loaded: false, ready: 0, inProgress: 0, next: null, note: '', claiming: false }
const work = atom({ plugin: 'hiveop', key: 'work' } as const, EMPTY_WORK, { shape: 'work-1' })
const EMPTY_SEAT: SeatView = { folder: 'unchecked', target: null, auto: false, seat: null, busy: false, note: '' }
const seat = atom({ plugin: 'hiveop', key: 'seat' } as const, EMPTY_SEAT, { shape: 'seat-1' })

// Chat for the person's workspace, and the one sync loop that keeps it live.
// The server rate-limits at 20/min: ONE request in flight, a floor between
// requests, back off on trouble, honour Retry-After.



const PANE = 'hiveop'
const WAIT_MS = 25_000
const MIN_GAP_MS = 3_500
const MAX_BACKOFF_MS = 60_000
const HISTORY = 40
const KEEP = 200
const STORE_OLD_WS = 'chat.workspace' // hcp-10's global current workspace: migrated, then dropped
const STORE_TABS = 'chat.tabs'

type ChatMem = {
  gen: number
  running: boolean
  inflight: boolean
  timer: { cancel: () => void } | null
  cursor: string | null
  failures: number
  clientId: string
}

function newChatMem(): ChatMem {
  return { gen: 0, running: false, inflight: false, timer: null, cursor: null, failures: 0, clientId: `plugin-${Math.random().toString(36).slice(2, 10)}` }
}

// ── parsing ──

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** The same person however the wallet is spelled (`email:<id>` or bare). */
function sameWallet(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const bare = (w: string) => (w.startsWith('email:') ? w.slice(6) : w)
  return bare(a) === bare(b)
}

const SELF_LABEL = 'You'
const AV_COLS = 4

function toMsg(raw: unknown, me: string | null): ChatMsg | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const id = str(m.id)
  const text = str(m.content)
  if (!id || !text) return null
  const meta = (m.metadata && typeof m.metadata === 'object' ? m.metadata : {}) as Record<string, unknown>
  // Mine = sent from my account and not by one of my agents. Never by display name.
  const mine = !str(meta.agentId) && sameWallet(str(m.senderWallet), me)
  const name = mine ? SELF_LABEL : str(meta.agentName).trim() || str(m.senderDisplayName).trim() || 'member'
  const at = Date.parse(str(m.createdAt)) || 0
  const agentId = str(meta.agentId)
  const wallet = str(m.senderWallet)
  // The run key: one person, however the wallet is spelled; an agent is its own sender and has no photo.
  const who = mine ? 'self' : agentId ? `agent:${agentId}` : bareWallet(wallet) || `name:${name}`
  const photo = agentId ? '' : mine ? (me ?? wallet) : wallet
  const color = /^#[0-9a-fA-F]{6}$/.test(str(meta.agentColor)) ? str(meta.agentColor) : null
  return { id, name, text, at, mine, who, photo, color }
}

function bareWallet(w: string): string {
  return w.startsWith('email:') ? w.slice(6) : w
}

// ── profile photos (hcp-21) ──
// Each person's photo is fetched at most once per session (a failure is cached too).
// The bytes live in this atom for the pane only: never in command output or the prompt.

const photoAsked = new Set<string>()
const PHOTO_BATCH = 6

async function ensurePhotos($: Engine): Promise<void> {
  const c = await read($, chat)
  const want: string[] = []
  const seenKeys = new Set<string>()
  for (const m of c.messages) {
    if (!m.photo) continue
    const k = bareWallet(m.photo)
    if (photoAsked.has(k) || seenKeys.has(k)) continue
    seenKeys.add(k)
    want.push(m.photo)
  }
  const batch = want.slice(0, PHOTO_BATCH)
  if (batch.length === 0) return
  for (const w of batch) photoAsked.add(bareWallet(w))
  await update($, photos, (p) => ({ byWallet: { ...p.byWallet, ...Object.fromEntries(batch.map((w) => [bareWallet(w), { state: 'loading', png: null }])) } }) as PhotosView)
  for (const w of batch) {
    const png = await fetchAvatar($, w)
    await update($, photos, (p) => ({ byWallet: { ...p.byWallet, [bareWallet(w)]: { state: png ? 'ok' : 'none', png } } }) as PhotosView)
  }
  if (want.length > batch.length) await ensurePhotos($)
}

async function resetPhotos($: Engine): Promise<void> {
  photoAsked.clear()
  await update($, photos, () => EMPTY_PHOTOS)
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!].map((w) => w[0]!) : [(words[0] ?? '?').slice(0, 1)]
  return letters.join('').toUpperCase()
}

function merge(list: ChatMsg[], incoming: ChatMsg[]): ChatMsg[] {
  const seen = new Set(list.map((m) => m.id))
  const added = incoming.filter((m) => !seen.has(m.id))
  if (added.length === 0) return list
  return [...list, ...added].sort((a, b) => a.at - b.at).slice(-KEEP)
}

function timeOf(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

// ── workspace ──

// ── open rooms (tabs) ──

const ROOM_LIMIT = 8

function tabsOf(v: ChatView): { id: string; name: string }[] {
  return v.tabs.map((t) => ({ id: t.id, name: t.name }))
}

/** Unread across every open room: the viewed one and the others. */
function unreadTotal(v: ChatView): number {
  return v.unread + v.tabs.reduce((n, t) => n + t.unread, 0)
}

async function saveTabs($: Engine, tabs: ChatTab[]): Promise<void> {
  await $.store.set(STORE_TABS, tabs.map((t) => ({ id: t.id, name: t.name })))
}

/**
 * Open rooms come back from the last session. hcp-10's single stored workspace
 * becomes the first tab, and its key is dropped.
 */
async function restoreTabs($: Engine): Promise<void> {
  const kept = await $.store.get(STORE_TABS)
  const old = (await $.store.get(STORE_OLD_WS)) as { id?: unknown; name?: unknown } | undefined
  const rooms: { id: string; name: string }[] = []
  const add = (x: unknown) => {
    const r = (x && typeof x === 'object' ? x : {}) as { id?: unknown; name?: unknown }
    if (str(r.id) && !rooms.some((t) => t.id === r.id)) rooms.push({ id: str(r.id), name: str(r.name) || 'workspace' })
  }
  if (old !== undefined) {
    add(old)
    for (const t of Array.isArray(kept) ? kept : []) add(t)
    await $.store.set(STORE_TABS, rooms)
    await $.store.delete(STORE_OLD_WS)
  } else for (const t of Array.isArray(kept) ? kept : []) add(t)
  const tabs = rooms.slice(0, ROOM_LIMIT).map((t) => ({ ...t, unread: 0 }))
  await update($, chat, (c) => ({ ...c, tabs, workspace: tabs[0] ? { id: tabs[0].id, name: tabs[0].name } : null, status: tabs[0] ? 'loading' : 'no-workspace', messages: [], unread: 0, firstNewId: null }) as ChatView)
}

async function loadHistory($: Engine, wsId: string, me: string | null): Promise<{ msgs: ChatMsg[] } | { r: Fetched | null }> {
  const r = await hiveop($, `/workspaces/${encodeURIComponent(wsId)}/chat?limit=${HISTORY}`)
  if (!r || !r.ok) return { r }
  const raw = Array.isArray(r.body?.messages) ? (r.body!.messages as unknown[]) : []
  return { msgs: raw.map((x) => toMsg(x, me)).filter((m): m is ChatMsg => m !== null) }
}

/** Is the chat in front of the person right now? */
async function isViewing($: Engine): Promise<boolean> {
  const v = await read($, chat)
  if (v.screen !== 'chat') return false
  const panes = await $.ui.panes()
  return panes.some((p) => p.id === PANE && p.isPlaced && p.isShown)
}

// ── what the person does ──

/** Make sure the viewed room's recent messages are in the view; one fetch when they are not. */
async function ensureLoaded($: Engine): Promise<void> {
  const v = await read($, chat)
  if (!v.workspace) {
    await update($, chat, (c) => ({ ...c, status: 'no-workspace' }) as ChatView)
    return
  }
  if (v.messages.length > 0) return
  const wsId = v.workspace.id
  const h = await loadHistory($, wsId, v.me)
  if ((await read($, chat)).workspace?.id !== wsId) return // moved while this was out
  if ('r' in h) {
    await update($, chat, (c) => ({ ...c, status: 'offline' }) as ChatView)
    return
  }
  await update($, chat, (c) => ({ ...c, status: 'ready', messages: merge(c.messages, h.msgs) }) as ChatView)
}

/** Open a workspace's room as a tab (or switch to it) and show it. */
async function openRoom($: Engine, ws: { id: string; name: string }): Promise<void> {
  const before = await read($, chat)
  const had = before.tabs.find((t) => t.id === ws.id)
  if (!had && before.tabs.length >= ROOM_LIMIT) {
    await setNav($, { note: 'Close a chat tab first.' })
    return
  }
  const pending = had?.unread ?? 0
  const ref = { id: ws.id, name: ws.name }
  const tabs: ChatTab[] = had ? before.tabs : [...before.tabs, { ...ref, unread: 0 }]
  const next = tabs.map((t) => (t.id === ws.id ? { ...t, unread: 0 } : t.id === before.workspace?.id ? { ...t, unread: before.unread } : t))
  const same = before.workspace?.id === ws.id
  await update($, chat, (c) =>
    ({
      ...c,
      tabs: next,
      screen: 'chat',
      ...(same ? { unread: 0 } : { workspace: ref, status: 'loading', messages: [], unread: 0, firstNewId: null, draft: '', send: { phase: 'idle' } }),
    }) as ChatView,
  )
  await setNav($, { screen: 'home', note: '' })
  if (!had) await saveTabs($, next)
  if (same) return
  const h = await loadHistory($, ws.id, before.me)
  if ((await read($, chat)).workspace?.id !== ws.id) return // switched again while this was out
  if ('r' in h) {
    await update($, chat, (c) => ({ ...c, status: 'offline' }) as ChatView)
    return
  }
  await update($, chat, (c) => {
    const msgs = merge([], h.msgs)
    return { ...c, status: 'ready', messages: msgs, firstNewId: pending > 0 ? (msgs[msgs.length - pending]?.id ?? null) : null } as ChatView
  })
}

/** Close a tab. Closing the viewed one moves to its neighbour. */
async function closeRoom($: Engine, id: string): Promise<void> {
  const v = await read($, chat)
  const at = v.tabs.findIndex((t) => t.id === id)
  if (at < 0) return
  const rest = v.tabs.filter((t) => t.id !== id)
  await saveTabs($, rest)
  if (v.workspace?.id !== id) {
    await update($, chat, (c) => ({ ...c, tabs: c.tabs.filter((t) => t.id !== id) }) as ChatView)
    return
  }
  const near = rest[Math.min(at, rest.length - 1)]
  if (!near) {
    await update($, chat, (c) => ({ ...c, tabs: [], workspace: null, status: 'no-workspace', messages: [], unread: 0, firstNewId: null, draft: '', send: { phase: 'idle' }, screen: 'home' }) as ChatView)
    return
  }
  await update($, chat, (c) => ({ ...c, tabs: c.tabs.filter((t) => t.id !== id), workspace: null, messages: [], unread: 0 }) as ChatView)
  await openRoom($, near)
}

/** Show the chat in the pane: the unread become the "N new" marker. */
async function openChat($: Engine): Promise<void> {
  await update($, chat, (c) => {
    const first = c.unread > 0 ? (c.messages[c.messages.length - c.unread]?.id ?? null) : null
    return { ...c, screen: 'chat', unread: 0, firstNewId: first } as ChatView
  })
}

async function closeChat($: Engine): Promise<void> {
  await update($, chat, (c) => ({ ...c, screen: 'home', firstNewId: null }) as ChatView)
}

async function setDraft($: Engine, text: string): Promise<void> {
  await update($, chat, (c) => ({ ...c, draft: text }) as ChatView)
}

type SendOutcome = 'sent' | 'empty' | 'failed' | 'limited' | 'signed-out' | 'no-room'

/** Post as the person. Never touches the message text outside the view and the request. */
async function sendChat($: Engine, mem: ChatMem, raw: string): Promise<SendOutcome> {
  const text = raw.trim()
  if (!text) return 'empty'
  const v = await read($, chat)
  if (!v.workspace) return 'no-room'
  await update($, chat, (c) => ({ ...c, draft: '', send: { phase: 'idle' } }) as ChatView)
  const r = await hiveop($, `/workspaces/${encodeURIComponent(v.workspace.id)}/chat`, { method: 'POST', body: { content: text } })
  if (!r) return 'signed-out'
  if (r.status === 429) {
    const seconds = r.retryAfterSec ?? 30
    await update($, chat, (c) => ({ ...c, send: { phase: 'limited', seconds, text } }) as ChatView)
    return 'limited'
  }
  if (!r.ok) {
    await update($, chat, (c) => ({ ...c, send: { phase: 'failed', text } }) as ChatView)
    if (r.status === 401) await dropKey($, mem)
    return 'failed'
  }
  const posted = toMsg(r.body?.message, v.me)
  const sent = posted ? { ...posted, name: SELF_LABEL, mine: true, who: 'self', photo: v.me ?? posted.photo } : null
  await update($, chat, (c) => {
    if (!sent) return { ...c, send: { phase: 'idle' } } as ChatView
    // The sync event can beat the reply: then it was counted as unread, and it is ours.
    const seen = c.messages.some((m) => m.id === sent.id)
    return { ...c, send: { phase: 'idle' }, unread: seen ? Math.max(0, c.unread - 1) : c.unread, messages: merge(c.messages, [sent]) } as ChatView
  })
  return 'sent'
}

async function retrySend($: Engine, mem: ChatMem): Promise<SendOutcome> {
  const v = await read($, chat)
  if (v.send.phase === 'idle') return 'empty'
  return sendChat($, mem, v.send.text)
}

// ── the sync loop ──

async function dropKey($: Engine, mem: ChatMem): Promise<void> {
  stopChat(mem)
  await forgetKey($)
  await update($, auth, () => ({ phase: 'ended', reason: 'rejected' }) as AuthView)
}

function stopChat(mem: ChatMem): void {
  mem.gen += 1
  mem.running = false
  mem.timer?.cancel()
  mem.timer = null
  mem.cursor = null
  mem.failures = 0
}

function startChat($: Engine, mem: ChatMem): void {
  if (mem.running) return
  mem.running = true
  mem.cursor = null
  mem.failures = 0
  mem.gen += 1
  const gen = mem.gen
  // Its own dispatch: the first step is not tied to the hook that signed in.
  mem.timer = $.clock.after(0, () => {
    void step($, mem, gen)
  })
}

function backoff(mem: ChatMem): number {
  mem.failures += 1
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(mem.failures, 6))
  return Math.round(base * (0.5 + Math.random() * 0.5))
}

/** The delay a failed request asks for; null when the key itself was refused. */
function afterFailure(mem: ChatMem, r: Fetched | null): number | null {
  if (!r) return null
  if (r.status === 401) return null
  if (r.status === 429) return (r.retryAfterSec ?? 30) * 1000
  if (r.status === 409) return 5000
  if (r.status === 0 || r.status >= 500) return backoff(mem)
  return Math.max(30_000, backoff(mem))
}

async function step($: Engine, mem: ChatMem, gen: number): Promise<void> {
  if (!mem.running || mem.inflight || mem.gen !== gen) return
  mem.inflight = true
  const started = await $.clock.now()
  let delay = 0
  try {
    delay = mem.cursor ? await syncOnce($, mem) : await bootstrap($, mem)
  } catch {
    delay = backoff(mem)
  } finally {
    mem.inflight = false
  }
  if (!mem.running || mem.gen !== gen) return
  const spent = (await $.clock.now()) - started
  mem.timer = $.clock.after(Math.max(delay, MIN_GAP_MS - spent, 0), () => {
    void step($, mem, gen)
  })
}

/** Take the head cursor and load the viewed room's recent history. Returns the delay before the next step. */
async function bootstrap($: Engine, mem: ChatMem): Promise<number> {
  const head = await hiveop($, `/me/sync?clientId=${mem.clientId}`)
  if (!head || !head.ok || typeof head.body?.cursor !== 'string') return failed($, mem, head)
  const v = await read($, chat)
  if (v.workspace && v.messages.length === 0) {
    const h = await loadHistory($, v.workspace.id, v.me)
    if ('r' in h) return failed($, mem, h.r)
    await update($, chat, (c) => (c.workspace?.id === v.workspace!.id ? ({ ...c, status: 'ready', messages: merge(c.messages, h.msgs) } as ChatView) : c))
  }
  mem.cursor = head.body.cursor
  mem.failures = 0
  await refreshWork($)
  return 0
}

async function failed($: Engine, mem: ChatMem, r: Fetched | null): Promise<number> {
  const delay = afterFailure(mem, r)
  if (delay === null) {
    if (r) await dropKey($, mem)
    else stopChat(mem)
    return 0
  }
  await update($, chat, (c) => ({ ...c, status: c.messages.length ? c.status : 'offline' }) as ChatView)
  return delay
}

async function syncOnce($: Engine, mem: ChatMem): Promise<number> {
  const r = await hiveop($, `/me/sync?cursor=${encodeURIComponent(mem.cursor ?? '')}&waitMs=${WAIT_MS}&clientId=${mem.clientId}`)
  if (!r || !r.ok) {
    if (r && r.status === 400) mem.cursor = null // a cursor the server no longer knows: start over
    return failed($, mem, r)
  }
  mem.failures = 0
  if (typeof r.body?.cursor === 'string') mem.cursor = r.body.cursor
  const events = Array.isArray(r.body?.events) ? (r.body!.events as Array<Record<string, unknown>>) : []
  const v = await read($, chat)
  await onWorkEvents($, events, v.me)
  const incoming: ChatMsg[] = []
  const elsewhere = new Map<string, number>()
  for (const ev of events) {
    if (ev.type !== 'workspace:chat_message') continue
    if (ev.workspaceId === v.workspace?.id) {
      const m = toMsg(ev.message, v.me)
      if (m) incoming.push(m)
    } else if (v.tabs.some((t) => t.id === ev.workspaceId)) {
      const id = str(ev.workspaceId)
      elsewhere.set(id, (elsewhere.get(id) ?? 0) + 1)
    }
  }
  if (elsewhere.size > 0) {
    await update($, chat, (c) => ({ ...c, tabs: c.tabs.map((t) => (elsewhere.has(t.id) ? { ...t, unread: t.unread + elsewhere.get(t.id)! } : t)) }) as ChatView)
  }
  if (incoming.length === 0) return 0
  const viewing = await isViewing($)
  await update($, chat, (c) => {
    const fresh = incoming.filter((m) => !c.messages.some((x) => x.id === m.id))
    if (fresh.length === 0) return c
    return {
      ...c,
      messages: merge(c.messages, fresh),
      unread: viewing ? 0 : c.unread + fresh.length,
      firstNewId: viewing && !c.firstNewId ? fresh[0]!.id : c.firstNewId,
    } as ChatView
  })
  return 0
}

// ── work band and Claim next (hcp-11) ──
// The summary is fetched when the workspace is chosen and again when sync says
// an issue in it changed: no polling. Titles are other people's words: band,
// pane, toasts and transcript notices, never a command's returned text.

const MAX_TOASTS = 3
const workRun = { inflight: false, dirty: false }

function oneLine(t: string, max = 60): string {
  const x = t.replace(/\s+/g, ' ').trim()
  return x.length > max ? `${x.slice(0, max - 1)}…` : x
}

async function setWork($: Engine, patch: Partial<WorkView>): Promise<void> {
  await update($, work, (w) => ({ ...w, ...patch }) as WorkView)
}

/** Fetch the seat workspace's counts and next item. Overlapping calls fold into one more fetch. */
async function refreshWork($: Engine, keepNote = false): Promise<void> {
  if (workRun.inflight) {
    workRun.dirty = true
    return
  }
  workRun.inflight = true
  try {
    do {
      workRun.dirty = false
      const wsId = (await read($, seat)).seat?.workspaceId ?? null
      if (!wsId) {
        await update($, work, () => EMPTY_WORK)
        continue
      }
      const out = await fetchWorkSummary($, wsId)
      if ((await read($, seat)).seat?.workspaceId !== wsId) {
        workRun.dirty = true // moved while this was out
        continue
      }
      if ('fail' in out) {
        await update($, work, (w) => (w.workspaceId === wsId ? w : { ...EMPTY_WORK, workspaceId: wsId }) as WorkView)
        continue
      }
      await update($, work, (w) => ({
        ...w,
        workspaceId: wsId,
        loaded: true,
        ready: out.summary.ready,
        inProgress: out.summary.inProgress,
        next: out.summary.next,
        note: keepNote ? w.note : '',
      }) as WorkView)
    } while (workRun.dirty)
  } finally {
    workRun.inflight = false
  }
}

/** Claim the top ready item as the person. Says the server's reason on a refusal. */
async function claimNext($: Engine): Promise<string> {
  if ((await read($, work)).claiming) return ''
  const wsId = (await read($, seat)).seat?.workspaceId
  if (!wsId) {
    await setSeat($, { note: 'Join a workspace first.' })
    return 'Join a workspace first.'
  }
  await setWork($, { claiming: true, note: '' })
  let note: string
  try {
    // Fresh, so a stale band never claims something already taken.
    const fresh = await fetchWorkSummary($, wsId)
    if ('fail' in fresh) note = refusal(fresh.fail)
    else if (!fresh.summary.next) note = 'Nothing ready to claim.'
    else {
      const r = await claimIssue($, wsId, fresh.summary.next.id)
      note = r && r.ok ? `Claimed: ${oneLine(fresh.summary.next.title)}` : refusal(r)
      if (r && r.ok) await noteClaim($, wsId, fresh.summary.next.title)
    }
  } catch {
    note = "Couldn't reach HiveOp."
  }
  await setWork($, { claiming: false, note })
  await refreshWork($, true)
  $.ui.toast(`HiveOp · ${note}`)
  return note
}

/** The seat remembers the item its agent holds (title only), so the system prompt can say so. */
async function noteClaim($: Engine, wsId: string, title: string): Promise<void> {
  await update($, seat, (v) => (v.seat && v.seat.workspaceId === wsId ? ({ ...v, seat: { ...v.seat, claimed: title } } as SeatView) : v))
}

function workKind(ev: Record<string, unknown>, status: string): 'new' | 'claimed' | 'done' | null {
  if (status === 'closed') return 'done'
  if (ev.action === 'create') return 'new'
  if (ev.action === 'claim') return 'claimed'
  return null
}

/** Toasts for what changed (at most three at once), and a fresh summary when it touched the seat workspace. */
async function onWorkEvents($: Engine, events: Array<Record<string, unknown>>, me: string | null): Promise<void> {
  const cur = (await read($, seat)).seat?.workspaceId
  const toasts: string[] = []
  let touched = false
  for (const ev of events) {
    if (ev.type !== 'workspace:issue_changed') continue
    if (ev.workspaceId === cur) touched = true
    const issue = (ev.issue && typeof ev.issue === 'object' ? ev.issue : {}) as Record<string, unknown>
    const kind = workKind(ev, str(issue.status))
    const title = oneLine(str(issue.title))
    if (!kind || !title) continue
    if (kind === 'claimed' && sameWallet(str(issue.assigneeWallet), me)) continue // the person's own claim
    toasts.push(`HiveOp · ${kind}: ${title}`)
  }
  const shown = toasts.length > MAX_TOASTS ? [...toasts.slice(0, MAX_TOASTS - 1), `HiveOp · +${toasts.length - (MAX_TOASTS - 1)} more`] : toasts
  for (const t of shown) $.ui.toast(t)
  if (touched) await refreshWork($)
}

function workText(w: WorkView): string {
  if (!w.loaded) return ''
  const next = w.next ? ` · next: ${oneLine(w.next.title, 40)}` : ''
  return ` · ${w.ready} ready · ${w.inProgress} in progress${next}`
}

// ── narrow windows ──

const NOT_JOINED = 'To code in it, open its folder and Join.'

/** Recent lines as transcript notices: drawn for the person, not sent to the model. */
async function logRecent($: Engine, count = 10): Promise<void> {
  const v = await read($, chat)
  if (!v.workspace) {
    $.ui.log('HiveOp chat · no chat open')
    return
  }
  if (v.status === 'offline' && v.messages.length === 0) {
    $.ui.log("HiveOp chat · couldn't reach HiveOp")
    return
  }
  $.ui.log(`HiveOp chat · #${v.workspace.name}`)
  if ((await read($, seat)).seat?.workspaceId !== v.workspace.id) $.ui.log(NOT_JOINED)
  const rows = v.messages.slice(-count)
  if (rows.length === 0) $.ui.log('No messages yet.')
  for (const m of rows) $.ui.log(`${m.name} · ${timeOf(m.at)} · ${m.text.replace(/\s+/g, ' ').slice(0, 400)}`)
}

// ── home, workspaces, people (hcp-10) ──
// Names in these lists are other people's: they are drawn in the pane or sent
// to transcript notices ($.ui.log), never returned from a command.

const STORE_BAND = 'band.hidden'
const PAGE = 6
const NARROW_PAGE = 12

async function setNav($: Engine, patch: Partial<NavView>): Promise<void> {
  await update($, nav, (n) => ({ ...n, ...patch }) as NavView)
}

async function setBand($: Engine, band: 'shown' | 'hidden'): Promise<void> {
  await setNav($, { band })
  await $.store.set(STORE_BAND, band === 'hidden')
}

async function restoreNav($: Engine): Promise<void> {
  const hidden = (await $.store.get(STORE_BAND)) === true
  await update($, nav, () => ({ ...EMPTY_NAV, band: hidden ? 'hidden' : 'shown' }) as NavView)
}

async function resetNav($: Engine): Promise<void> {
  await update($, nav, (n) => ({ ...EMPTY_NAV, band: n.band }) as NavView)
}

async function loadMine($: Engine): Promise<void> {
  const out = await listMine($)
  if ('fail' in out) {
    await setNav($, { note: refusal(out.fail) })
    return
  }
  await setNav($, { mine: out.rows })
  try {
    const home = (await $.env.get('HOME')) ?? ''
    await setNav($, { clones: await scanClones($, sm.cwd, home) })
  } catch {
    // No clones known: rows simply offer no Open.
  }
}

/** Open the workspace's clone in a new terminal tab; on any trouble, show the command to copy. */
async function openRow($: Engine, row: WsRow, dir: string, canLaunch: boolean): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  await writeJoinOnOpen($, folderKey(dir), row.id)
  const out = await openFolder($, dir, inlinePluginDir($.plugin.root, home), canLaunch)
  await setNav($, { note: out.ok ? `Opened ${oneLine(row.name, 40)}.` : out.command })
}

const cloning = new Set<string>()

/** Get code: clone the repo with the person's own git access, remember the folder, then Open. */
async function getCode($: Engine, row: WsRow, canLaunch: boolean): Promise<void> {
  if (cloning.has(row.id)) return
  cloning.add(row.id)
  const name = oneLine(row.name, 40)
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const target = await chooseCloneFolder($, home, row.name, row.repoUrl)
    if (!target.existing) {
      await setNav($, { note: `Cloning ${name}…` })
      let last = -1
      const out = await cloneRepo($, row.repoUrl, target.dir, (p) => {
        if (p === last) return
        last = p
        void setNav($, { note: `Cloning ${name}… ${p}%` })
      })
      if (!out.ok) {
        await setNav($, { note: out.reason })
        return
      }
    }
    await rememberClone($, row.repoUrl, target.dir)
    await setNav($, { clones: { ...(await read($, nav)).clones, [normRemote(row.repoUrl)]: target.dir } })
    await openRow($, row, target.dir, canLaunch)
  } catch {
    await setNav($, { note: 'Clone failed.' })
  } finally {
    cloning.delete(row.id)
  }
}

async function loadInvites($: Engine): Promise<void> {
  const out = await listInvites($)
  if ('fail' in out) {
    await setNav($, { note: refusal(out.fail) })
    return
  }
  await setNav($, { invites: out.rows })
}

async function answerInvite($: Engine, row: InviteRow, accept: boolean): Promise<void> {
  const r = accept ? await acceptInvite($, row.token) : await declineInvite($, row.id)
  if (!r || !r.ok) {
    await setNav($, { note: refusal(r) })
    return
  }
  await update($, nav, (n) => ({
    ...n,
    note: accept ? `Joined ${row.wsName}.` : `Declined ${row.wsName}.`,
    invites: (n.invites ?? []).filter((i) => i.id !== row.id),
    mine: accept ? null : n.mine,
  }) as NavView)
}

async function loadExplore($: Engine, search: string, offset: number, limit = PAGE): Promise<void> {
  const out = await listExplore($, search, offset, limit)
  if ('fail' in out) {
    await setNav($, { note: refusal(out.fail) })
    return
  }
  await update($, nav, (n) => ({ ...n, note: '', explore: { search, rows: out.rows, offset, total: out.total, loaded: true } }) as NavView)
}

async function setExploreText($: Engine, text: string): Promise<void> {
  await update($, nav, (n) => ({ ...n, explore: { ...n.explore, search: text } }) as NavView)
}

/** Open workspaces are joined; the rest are asked. The server's refusal is shown as it said it. */
async function joinRow($: Engine, row: WsRow): Promise<void> {
  const ask = row.kind !== 'github'
  const r = ask ? await requestToJoin($, row.id) : await joinWorkspace($, row.id)
  if (!r || !r.ok) {
    await setNav($, { note: refusal(r) })
    return
  }
  if (ask) {
    await setNav($, { note: `Asked to join ${row.name}.` })
    return
  }
  const standing = ((r.body?.workspace ?? {}) as { standing?: unknown }).standing
  await setNav($, { note: standing === 'visitor' ? `Visiting ${row.name}.` : `Joined ${row.name}.`, mine: null })
}

async function loadPeople($: Engine, query: string, offset: number, limit = PAGE): Promise<void> {
  const out = await listPilots($, query, offset, limit + 1)
  if ('fail' in out) {
    await setNav($, { note: refusal(out.fail) })
    return
  }
  const me = (await read($, chat)).me
  const all = out.rows.filter((p) => !sameWallet(p.wallet, me))
  const rows = all.slice(0, limit)
  const following = (await followingAmong($, rows.map((p) => p.wallet))) ?? []
  await update($, nav, (n) => ({ ...n, note: '', people: { query, rows, following, offset, more: out.rows.length > limit, loaded: true } }) as NavView)
}

async function setPeopleText($: Engine, text: string): Promise<void> {
  await update($, nav, (n) => ({ ...n, people: { ...n.people, query: text } }) as NavView)
}

async function toggleFollow($: Engine, p: PilotRow): Promise<void> {
  const was = (await read($, nav)).people.following.includes(p.wallet)
  const r = await setFollow($, p.wallet, !was)
  if (!r || !r.ok) {
    await setNav($, { note: refusal(r) })
    return
  }
  await update($, nav, (n) => ({
    ...n,
    note: was ? `Unfollowed ${p.name}.` : `Following ${p.name}.`,
    people: { ...n.people, following: was ? n.people.following.filter((w) => w !== p.wallet) : [...n.people.following, p.wallet] },
  }) as NavView)
}

async function showTab($: Engine, tab: NavView['tab']): Promise<void> {
  await setNav($, { tab, note: '' })
  const n = await read($, nav)
  if (tab === 'mine') await loadMine($)
  else if (tab === 'invites') await loadInvites($)
  else if (!n.explore.loaded) await loadExplore($, '', 0)
}

/** Move the pane to home, workspaces or people. The chat room steps aside. */
async function goTo($: Engine, screen: NavView['screen']): Promise<void> {
  await closeChat($)
  await setNav($, { screen, note: '' })
  if (screen === 'workspaces') await showTab($, 'mine')
  if (screen === 'people') await loadPeople($, '', 0)
}

// ── narrow windows: the same choices as pick-lists ──

async function ask($: Engine, question: string, options: string[]): Promise<string | null> {
  try {
    return await $.ui.ask(question, options)
  } catch {
    return null
  }
}

type Chosen = { item: number } | { text: string } | null

/** Three at a time, then More… (the dialog takes 2-4 options). Typed text under Other comes back as `text`. */
async function pickFrom($: Engine, question: string, labels: string[]): Promise<Chosen> {
  const seen = new Map<string, number>()
  const unique = labels.map((l) => {
    const n = (seen.get(l) ?? 0) + 1
    seen.set(l, n)
    return n === 1 ? l : `${l} (${n})`
  })
  let page = 0
  for (;;) {
    const items = unique.slice(page * 3, page * 3 + 3)
    const more = (page + 1) * 3 < unique.length
    const answer = await ask($, question, [...items, more ? 'More…' : 'Back'])
    if (answer === null || answer === 'Back') return null
    if (answer === 'More…') {
      page += 1
      continue
    }
    const at = items.indexOf(answer)
    return at >= 0 ? { item: page * 3 + at } : { text: answer.trim() }
  }
}

async function say($: Engine): Promise<void> {
  const note = (await read($, nav)).note
  if (note) $.ui.log(note)
}

async function narrowWorkspaces($: Engine): Promise<void> {
  for (;;) {
    const tab = await ask($, 'Workspaces', ['Mine', 'Invites', 'Explore', 'Back'])
    if (tab === 'Mine') {
      await loadMine($)
      const n = await read($, nav)
      if (!n.mine || n.mine.length === 0) {
        $.ui.log(n.note || 'No workspaces yet.')
        continue
      }
      const rows = n.mine
      const got = await pickFrom($, 'Open chat in which?', rows.map((w) => w.name))
      if (got && 'item' in got) {
        await openRoom($, rows[got.item]!)
        await ensureLoaded($)
        await logRecent($)
        return
      }
    } else if (tab === 'Invites') {
      await loadInvites($)
      const n = await read($, nav)
      if (!n.invites || n.invites.length === 0) {
        $.ui.log(n.note || 'No invites.')
        continue
      }
      const rows = n.invites
      const got = await pickFrom($, 'Which invite?', rows.map((i) => i.wsName))
      if (got && 'item' in got) {
        const row = rows[got.item]!
        const what = await ask($, `Invite to ${row.wsName}`, ['Accept', 'Decline', 'Back'])
        if (what === 'Accept' || what === 'Decline') {
          await answerInvite($, row, what === 'Accept')
          await say($)
          return
        }
      }
    } else if (tab === 'Explore') {
      let search = ''
      for (;;) {
        await loadExplore($, search, 0, NARROW_PAGE)
        const n = await read($, nav)
        if (n.explore.rows.length === 0) {
          $.ui.log(n.note || 'No workspaces found.')
          break
        }
        const rows = n.explore.rows
        const got = await pickFrom($, 'Join which? Or type a search.', rows.map((w) => w.name))
        if (got && 'text' in got) {
          search = got.text
          continue
        }
        if (got) {
          const row = rows[got.item]!
          const verb = row.kind === 'github' ? 'Join' : 'Request to join'
          const what = await ask($, row.name, [verb, 'Back'])
          if (what === verb) {
            await joinRow($, row)
            await say($)
            return
          }
        }
        break
      }
    } else return
  }
}

async function narrowPeople($: Engine): Promise<void> {
  let query = ''
  for (;;) {
    await loadPeople($, query, 0, NARROW_PAGE)
    const n = await read($, nav)
    const rows = n.people.rows
    if (rows.length === 0) {
      $.ui.log(n.note || 'No one found.')
      return
    }
    const got = await pickFrom($, 'Which person? Or type a search.', rows.map((p) => (n.people.following.includes(p.wallet) ? `${p.name} · following` : p.name)))
    if (got && 'text' in got) {
      query = got.text
      continue
    }
    if (!got) return
    const p = rows[got.item]!
    const on = n.people.following.includes(p.wallet)
    const verb = on ? 'Unfollow' : 'Follow'
    const what = await ask($, p.name, [verb, 'Back'])
    if (what === verb) {
      await toggleFollow($, p)
      await say($)
      return
    }
  }
}


// ── this window's seat (hcp-15, ADR-0019) ──
// The folder decides the workspace: a folder whose git remote is one of the
// person's workspaces offers "Join as agent". Joining registers THIS window as
// an Adopted session; the model is told only the seat (workspace, agent name,
// claimed item), never chat. Module variables start over on a reload;
// session.start sets them again.

const STORE_AUTO = 'join.auto'
const sm = { cwd: '', folderKey: '', sessionKey: '' }

async function setSeat($: Engine, patch: Partial<SeatView>): Promise<void> {
  await update($, seat, (v) => ({ ...v, ...patch }) as SeatView)
}

/** One line of a name or title, safe to put in the system prompt. */
function oneLinePrompt(t: string, max: number): string {
  const x = t.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim()
  return x.length > max ? `${x.slice(0, max - 1)}…` : x
}

/** The seat facts, and only those. */
function seatText(v: NonNullable<SeatView['seat']>): string {
  const ws = oneLinePrompt(v.workspaceName, 60)
  const claimed = v.claimed ? ` Claimed item: ${oneLinePrompt(v.claimed, 80)}.` : ''
  return `HiveOp seat: this session is the agent "${oneLinePrompt(v.name, 40)}" in the HiveOp workspace "${ws}" (id ${v.workspaceId}).${claimed}`
}

/** Look at the folder's git remote and ask HiveOp which workspace it belongs to. Joins by itself when the person chose that. */
async function detectFolder($: Engine): Promise<void> {
  try {
    if ((await read($, auth)).phase !== 'signed-in' || !sm.cwd) return
    if ((await read($, seat)).seat) return
    const remote = await gitRemote($, sm.cwd)
    const m = remote ? await matchWorkspaces($, remote) : null
    const opened = await takeJoinOnOpen($, sm.folderKey)
    const mine = (opened ? m?.mine.find((x) => x.id === opened) : undefined) ?? m?.mine[0]
    const other = m?.joinable[0]
    if (remote && (mine || other)) await rememberClone($, remote, sm.cwd)
    if (mine) await setSeat($, { folder: 'mine', target: mine })
    else if (other) await setSeat($, { folder: 'joinable', target: other })
    else {
      await setSeat($, { folder: 'none', target: null })
      return
    }
    const v = await read($, seat)
    if (mine && (v.auto || (opened && mine.id === opened))) await joinSeat($, mine)
  } catch {
    // The folder stays unchecked; the band simply offers nothing.
  }
}

async function joinSeat($: Engine, ws: { id: string; name: string }): Promise<void> {
  const cur = await read($, seat)
  if (cur.busy || cur.seat) return
  await setSeat($, { busy: true, note: '' })
  try {
    if (!sm.sessionKey) {
      try {
        sm.sessionKey = await $.session.id()
      } catch {
        sm.sessionKey = `s${await $.clock.now()}`
      }
    }
    const out = await adoptSession($, ws.id, sm.folderKey, sm.sessionKey)
    if ('fail' in out) {
      await setSeat($, { busy: false, note: refusal(out.fail) })
      return
    }
    await setSeat($, {
      busy: false,
      note: '',
      seat: { workspaceId: ws.id, workspaceName: ws.name, agentId: out.seat.agentId, name: out.seat.name, claimed: null },
    })
    $.ui.toast(`HiveOp · joined ${oneLine(ws.name, 40)} as ${oneLine(out.seat.name, 30)}`)
    await refreshWork($)
  } catch {
    await setSeat($, { busy: false, note: "Couldn't reach HiveOp." })
  }
}

/** Leave the workspace: the agent goes offline (its history stays). */
async function leaveSeat($: Engine): Promise<void> {
  const v = await read($, seat)
  if (!v.seat) return
  await setSeat($, { seat: null, note: '' })
  await update($, work, () => EMPTY_WORK)
  try {
    await leaveSession($, v.seat.workspaceId, v.seat.agentId)
  } catch {
    // Offline either way once the session ends.
  }
}

async function requestSeatAccess($: Engine): Promise<void> {
  const v = await read($, seat)
  if (!v.target) return
  const r = await requestToJoin($, v.target.id)
  await setSeat($, { note: r && r.ok ? `Asked to join ${oneLine(v.target.name, 40)}.` : refusal(r) })
}

async function setAuto($: Engine, on: boolean): Promise<void> {
  await $.store.set(STORE_AUTO, on)
  await setSeat($, { auto: on })
  if (on) {
    const v = await read($, seat)
    if (v.folder === 'mine' && v.target && !v.seat) await joinSeat($, v.target)
  }
}

/** Home's Work here: this folder's workspace, else one of the person's own. */
async function workHere($: Engine): Promise<string> {
  let v = await read($, seat)
  if (v.seat) return `Already in ${oneLine(v.seat.workspaceName, 40)}.`
  if (v.folder === 'unchecked') {
    await detectFolder($)
    v = await read($, seat)
    if (v.seat) return `Joined ${oneLine(v.seat.workspaceName, 40)}.`
  }
  if (v.folder === 'mine' && v.target) {
    await joinSeat($, v.target)
  } else if (v.folder === 'joinable' && v.target) {
    await requestSeatAccess($)
  } else {
    // The folder decides the workspace (PRD Δ 2026-11-09): never seat an agent in a
    // workspace whose code isn't in this folder.
    const note = "This folder isn't a workspace's repo. Open Claude Code in your workspace's folder to work there."
    await setSeat($, { note })
    return note
  }
  const after = await read($, seat)
  return after.seat ? `Joined ${oneLine(after.seat.workspaceName, 40)}.` : after.note || 'Done.'
}

const POLL_MS = 3000
const MAX_POLL_FAILURES = 5


type Cancel = { cancel: () => void }
// Module variables start over on a reload; session.start resets the view to match.
type Mem = { timer: Cancel | null; pollToken: string | null; failures: number; expiresAtMs: number; chat: ChatMem }

const ENDED_TEXT: Record<Extract<AuthView, { phase: 'ended' }>['reason'], string> = {
  denied: 'Sign-in was denied.',
  expired: 'The code expired.',
  'not-open': "HiveOp for Claude Code isn't open yet.",
  unreachable: "Couldn't reach HiveOp.",
  rejected: 'HiveOp no longer accepts this sign-in.',
}

function stopPolling(mem: Mem) {
  mem.timer?.cancel()
  mem.timer = null
  mem.pollToken = null
  mem.failures = 0
}

async function finishSignedIn($: Engine, mem: Mem) {
  const me = await fetchMe($)
  if (me.state === 'rejected') {
    await forgetKey($)
    await update($, auth, () => ({ phase: 'ended', reason: 'rejected' }) as AuthView)
    return
  }
  await update($, auth, () => ({ phase: 'signed-in', name: me.state === 'ok' ? me.name : null }) as AuthView)
  await update($, chat, (c) => ({ ...c, me: me.state === 'ok' ? me.wallet : c.me }))
  await restoreTabs($)
  startChat($, mem.chat)
  await detectFolder($)
}

async function tick($: Engine, mem: Mem) {
  const token = mem.pollToken
  if (!token) return
  if ((await $.clock.now()) >= mem.expiresAtMs) {
    stopPolling(mem)
    await update($, auth, () => ({ phase: 'ended', reason: 'expired' }) as AuthView)
    return
  }
  const r = await pollPairing($, token)
  if (mem.pollToken !== token) return // cancelled while the request was out
  if (r.status === 'pending') {
    mem.failures = 0
    return
  }
  if (r.status === 'unreachable') {
    mem.failures += 1
    if (mem.failures >= MAX_POLL_FAILURES) {
      stopPolling(mem)
      await update($, auth, () => ({ phase: 'ended', reason: 'unreachable' }) as AuthView)
    }
    return
  }
  stopPolling(mem)
  if (r.status === 'approved') {
    if (!(await saveKey($, r.key))) {
      await update($, auth, () => ({ phase: 'ended', reason: 'unreachable' }) as AuthView)
      return
    }
    await finishSignedIn($, mem)
    $.ui.toast('HiveOp · signed in')
    return
  }
  const reason = r.status === 'denied' ? r.reason : 'expired'
  await update($, auth, () => ({ phase: 'ended', reason }) as AuthView)
}

async function signIn($: Engine, mem: Mem): Promise<AuthView> {
  stopPolling(mem)
  const pairing = await startPairing($, await computerName($))
  if (!pairing) {
    const view: AuthView = { phase: 'ended', reason: 'unreachable' }
    await update($, auth, () => view)
    return view
  }
  const view: AuthView = { phase: 'pairing', code: pairing.code, link: pairing.link, expiresAt: pairing.expiresAt }
  mem.pollToken = pairing.pollToken
  mem.expiresAtMs = Date.parse(pairing.expiresAt) || (await $.clock.now()) + 10 * 60_000
  await update($, auth, () => view)
  mem.timer = $.clock.every(POLL_MS, () => {
    void tick($, mem)
  })
  return view
}

async function signOut($: Engine, mem: Mem) {
  await leaveSeat($)
  await update($, seat, (v) => ({ ...EMPTY_SEAT, auto: v.auto }) as SeatView)
  stopPolling(mem)
  stopChat(mem.chat)
  await forgetKey($)
  await update($, auth, () => ({ phase: 'signed-out' }) as AuthView)
  await update($, chat, () => EMPTY_CHAT)
  await resetPhotos($)
  await update($, work, () => EMPTY_WORK)
  await resetNav($)
}

async function restore($: Engine, mem: Mem) {
  stopPolling(mem)
  if (await loadKey($)) {
    await update($, auth, () => ({ phase: 'signed-in', name: null }) as AuthView)
    await finishSignedIn($, mem)
  } else {
    stopChat(mem.chat)
    await update($, auth, () => ({ phase: 'signed-out' }) as AuthView)
  }
}

function bandText(v: AuthView): string {
  switch (v.phase) {
    case 'signed-out':
      return ' · Sign in'
    case 'pairing':
      return ` · code ${v.code} · approve at app.hiveop.io/claude-code`
    case 'signed-in':
      return ` · ${v.name ?? 'you'}`
    case 'ended':
      return ` · ${ENDED_TEXT[v.reason]}`
  }
}

// HiveOp brand cyan (app.hiveop.io accent).
const BRAND = '#22D3EE'

export const register: Register = (on) => {
  const mem: Mem = { timer: null, pollToken: null, failures: 0, expiresAtMs: 0, chat: newChatMem() }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hiveop', description: 'HiveOp: sign in, chat, your account in Claude Code' })
    await $.command.register({ name: 'say', description: 'Say something in your HiveOp workspace chat', argumentHint: '<message>' })
    await restoreNav($)
    await resetPhotos($)
    sm.cwd = e.cwd
    sm.folderKey = folderKey(e.cwd)
    try {
      sm.sessionKey = await $.session.id()
    } catch {
      sm.sessionKey = ''
    }
    const auto = (await $.store.get(STORE_AUTO)) === true
    await update($, seat, (v) => ({ ...EMPTY_SEAT, auto, seat: v.seat }) as SeatView)
    await restore($, mem)
    return next(e)
  })

  // The model is told this window's seat and nothing else from HiveOp.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const v = await read($, seat)
    if (!v.seat) return r
    return { sections: [...r.sections, { id: 'hiveop:seat', text: seatText(v.seat), scope: 'session' as const }] }
  })

  on('session.end', async ($, e, next) => {
    await leaveSeat($)
    return next(e)
  })

  // Commands answer in neutral words only. Other people's messages go to the
  // pane or to transcript notices ($.ui.log), never into this text, which the
  // model reads.
  on('command.run', { command: 'say' }, async ($, e) => {
    const view = await read($, auth)
    if (view.phase !== 'signed-in') return { text: 'Sign in first: /hiveop sign-in' }
    const text = (e.args ?? '').trim()
    if (!text) return { text: 'Usage: /say <message>' }
    const out = await sendChat($, mem.chat, text)
    return { text: sayText(out, await read($, chat)) }
  })

  on('command.run', { command: 'hiveop' }, async ($, e) => {
    let view = await read($, auth)
    const sub = (e.args ?? '').trim().toLowerCase()
    if (sub === 'sign-out' || sub === 'signout') {
      await signOut($, mem)
      return { text: 'Signed out of HiveOp on this computer.' }
    }
    if (view.phase !== 'signed-in' && view.phase !== 'pairing') view = await signInIfAsked($, mem, view, sub)

    const signed = view.phase === 'signed-in'
    const wantsChat = sub === 'chat' && signed
    const wantsNav = signed && (sub === 'workspaces' || sub === 'people') ? sub : null
    const opened = await $.ui.open({ id: PANE, title: 'HiveOp' })
    if (wantsNav) {
      if (opened.isPlaced) {
        await goTo($, wantsNav)
        return { text: 'HiveOp opened.' }
      }
      await (wantsNav === 'workspaces' ? narrowWorkspaces($) : narrowPeople($))
      return { text: 'Done.' }
    }
    if (opened.isPlaced && signed) await goTo($, 'home')
    if (wantsChat) {
      await ensureLoaded($)
      if (opened.isPlaced) {
        if (!(await read($, chat)).workspace) {
          await goTo($, 'workspaces')
          return { text: 'Pick a workspace.' }
        }
        await openChat($)
        return { text: 'Opened chat.' }
      }
      await logRecent($)
      return { text: 'Opened chat.' }
    }
    if (opened.isPlaced) return { text: 'HiveOp opened.' }
    // Too narrow for a pane: a short pick-list, then plain words.
    return { text: await narrow($, mem, view) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, auth)
    if (e.props.hasSurvey) return next(e)
    const c = await read($, chat)
    const nv = await read($, nav)
    const wk = await read($, work)
    const st = await read($, seat)
    if (nv.band === 'hidden') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text wrap="truncate-end">
          <Text color={BRAND} bold>HiveOp</Text>
          {v.phase === 'signed-in' && st.seat
            ? ` · ${oneLine(st.seat.workspaceName, 30)} · ${oneLine(st.seat.name, 30)}`
            : v.phase === 'signed-in' && st.target
              ? ` · ${oneLine(st.target.name, 30)} ·`
              : bandText(v)}
          {v.phase === 'signed-in' && !st.seat && st.folder === 'none' && ' · Not a workspace folder'}
          {v.phase === 'signed-in' && st.note !== '' && ` · ${oneLine(st.note, 70)}`}
          {v.phase === 'signed-in' && unreadTotal(c) > 0 && <Text bold color={BRAND}>{` · ${unreadTotal(c)} new`}</Text>}
          {v.phase === 'signed-in' && st.seat && workText(wk)}
          {v.phase === 'signed-in' && st.seat && wk.note !== '' && ` · ${oneLine(wk.note, 70)}`}
        </Text>
        {(v.phase === 'signed-out' || v.phase === 'ended') && (
          <Button key="band-sign-in" label=" Sign in" onPress={() => void signIn($, mem)} />
        )}
        {v.phase === 'signed-in' && !st.seat && st.folder === 'mine' && st.target && (
          <Button key="band-join" label={st.busy ? ' Joining…' : ' Join as agent'} variant="primary" onPress={() => void joinSeat($, st.target!)} />
        )}
        {v.phase === 'signed-in' && !st.seat && st.folder === 'joinable' && (
          <Button key="band-request" label=" Request to join" onPress={() => void requestSeatAccess($)} />
        )}
        {v.phase === 'signed-in' && st.seat && <Button key="band-leave" label=" Leave" onPress={() => void leaveSeat($)} />}
        {v.phase === 'signed-in' && <Button key="band-chat" label=" Chat" onPress={() => void showChat($)} />}
        {v.phase === 'signed-in' && st.seat && wk.loaded && wk.ready > 0 && (
          <Button key="band-claim" label={wk.claiming ? ' Claiming…' : ' Claim'} onPress={() => void claimNext($)} />
        )}
        <Button key="band-hide" label=" Hide" onPress={() => void setBand($, 'hidden')} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await read($, auth)
    const c = await read($, chat)
    const nv = await read($, nav)
    const wk = await read($, work)
    const st = await read($, seat)
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    // Image exists on the terminal surface only; everywhere else the initials stand in.
    const Img = e.surface === 'terminal' ? ($.ui.resolve(e) as Partial<Elements['terminal']>).Image : undefined
    const ph = await read($, photos)
    if (v.phase === 'signed-in' && c.screen === 'chat') void ensurePhotos($)
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 9)
    if (v.phase === 'signed-in' && c.screen !== 'chat' && nv.screen === 'workspaces') {
      const ex = nv.explore
      return (
        <Box flexDirection="column">
          <Box>
            <Text bold color={BRAND}>Workspaces</Text>
            <Button key="nav-back" label=" Back" onPress={() => void goTo($, 'home')} />
          </Box>
          <Box>
            <Button key="tab-mine" label="Mine" variant={nv.tab === 'mine' ? 'primary' : undefined} onPress={() => void showTab($, 'mine')} />
            <Button
              key="tab-invites"
              label={nv.invites && nv.invites.length > 0 ? `Invites · ${nv.invites.length}` : 'Invites'}
              variant={nv.tab === 'invites' ? 'primary' : undefined}
              onPress={() => void showTab($, 'invites')}
            />
            <Button key="tab-explore" label="Explore" variant={nv.tab === 'explore' ? 'primary' : undefined} onPress={() => void showTab($, 'explore')} />
          </Box>
          {nv.note !== '' && <Text bold>{nv.note}</Text>}
          {nv.tab === 'mine' && nv.mine === null && <Text>Loading…</Text>}
          {nv.tab === 'mine' && nv.mine !== null && nv.mine.length === 0 && <Text>No workspaces yet. Create one at app.hiveop.io.</Text>}
          {nv.tab === 'mine' &&
            (nv.mine ?? []).slice(0, room).map((w) => (
              <Box>
                <Text>{`${w.name} `}</Text>
                {(() => {
                  const dir = nv.clones[normRemote(w.repoUrl)]
                  if (st.seat?.workspaceId === w.id) return <Text>{'Joined '}</Text>
                  if (st.folder === 'mine' && st.target?.id === w.id)
                    return <Button key={`ws-code-${w.id}`} label="Code here" variant="primary" onPress={() => void joinSeat($, w)} />
                  if (dir) return <Button key={`ws-open-${w.id}`} label="Open" onPress={() => void openRow($, w, dir, e.surface === 'terminal')} />
                  if (w.kind === 'github' && cloneableUrl(w.repoUrl))
                    return <Button key={`ws-get-${w.id}`} label="Get code" onPress={() => void getCode($, w, e.surface === 'terminal')} />
                  return null
                })()}
                <Text>{' your Claude plan '}</Text>
                <Button key={`ws-chat-${w.id}`} label="Open chat" variant={c.tabs.some((t) => t.id === w.id) ? undefined : 'primary'} onPress={() => void openRoom($, w)} />
              </Box>
            ))}
          {nv.tab === 'invites' && nv.invites === null && <Text>Loading…</Text>}
          {nv.tab === 'invites' && nv.invites !== null && nv.invites.length === 0 && <Text>No invites.</Text>}
          {nv.tab === 'invites' &&
            (nv.invites ?? []).slice(0, room).map((i) => (
              <Box>
                <Text>{`${i.wsName} `}</Text>
                <Button key={`inv-accept-${i.id}`} label="Accept" variant="primary" onPress={() => void answerInvite($, i, true)} />
                <Button key={`inv-decline-${i.id}`} label="Decline" onPress={() => void answerInvite($, i, false)} />
              </Box>
            ))}
          {nv.tab === 'explore' && (
            <Input
              key="ex-search"
              placeholder="Search public workspaces…"
              value={ex.search}
              submitLabel="search"
              onInput={(t) => void setExploreText($, t)}
              onSubmit={(t) => void loadExplore($, t.trim(), 0)}
            />
          )}
          {nv.tab === 'explore' && !ex.loaded && <Text>Loading…</Text>}
          {nv.tab === 'explore' && ex.loaded && ex.rows.length === 0 && <Text>No workspaces found.</Text>}
          {nv.tab === 'explore' &&
            ex.rows.map((w) => (
              <Box>
                <Text>{`${w.name}${w.members !== null ? ` · ${w.members}` : ''} `}</Text>
                {(w.kind === 'github' || w.canJoin) && (
                  <Button key={`ex-join-${w.id}`} label={w.kind === 'github' ? 'Join' : 'Request to join'} onPress={() => void joinRow($, w)} />
                )}
                {w.kind !== 'github' && !w.canJoin && <Text>closed</Text>}
              </Box>
            ))}
          {nv.tab === 'explore' && ex.loaded && (ex.offset > 0 || ex.offset + ex.rows.length < ex.total) && (
            <Box>
              {ex.offset > 0 && <Button key="ex-prev" label="Prev" onPress={() => void loadExplore($, ex.search, Math.max(0, ex.offset - PAGE))} />}
              <Text>{` ${ex.offset + 1}–${ex.offset + ex.rows.length} of ${ex.total} `}</Text>
              {ex.offset + ex.rows.length < ex.total && <Button key="ex-next" label="Next" onPress={() => void loadExplore($, ex.search, ex.offset + PAGE)} />}
            </Box>
          )}
        </Box>
      )
    }
    if (v.phase === 'signed-in' && c.screen !== 'chat' && nv.screen === 'people') {
      const pp = nv.people
      return (
        <Box flexDirection="column">
          <Box>
            <Text bold color={BRAND}>People</Text>
            <Button key="nav-back" label=" Back" onPress={() => void goTo($, 'home')} />
          </Box>
          <Input
            key="pp-search"
            placeholder="Search pilots…"
            value={pp.query}
            submitLabel="search"
            onInput={(t) => void setPeopleText($, t)}
            onSubmit={(t) => void loadPeople($, t.trim(), 0)}
          />
          {nv.note !== '' && <Text bold>{nv.note}</Text>}
          {!pp.loaded && <Text>Loading…</Text>}
          {pp.loaded && pp.rows.length === 0 && <Text>No one found.</Text>}
          {pp.rows.map((p) => (
            <Box>
              <Text>{`${p.name} `}</Text>
              {pp.following.includes(p.wallet) ? (
                <Button key={`pp-unfollow-${p.wallet}`} label="Unfollow" onPress={() => void toggleFollow($, p)} />
              ) : (
                <Button key={`pp-follow-${p.wallet}`} label="Follow" variant="primary" onPress={() => void toggleFollow($, p)} />
              )}
              {pp.following.includes(p.wallet) && <Text>{' · following'}</Text>}
            </Box>
          ))}
          {pp.loaded && (pp.offset > 0 || pp.more) && (
            <Box>
              {pp.offset > 0 && <Button key="pp-prev" label="Prev" onPress={() => void loadPeople($, pp.query, Math.max(0, pp.offset - PAGE))} />}
              {pp.more && <Button key="pp-next" label="Next" onPress={() => void loadPeople($, pp.query, pp.offset + PAGE)} />}
            </Box>
          )}
        </Box>
      )
    }
    if (v.phase === 'signed-in' && c.screen === 'chat') {
      const room = Math.max(3, (e.viewport?.rows ?? 24) - 6)
      const shown = c.messages.slice(-room)
      const marker = c.firstNewId ? c.messages.findIndex((m) => m.id === c.firstNewId) : -1
      const newCount = marker >= 0 ? c.messages.length - marker : 0
      return (
        <Box flexDirection="column">
          <Box>
            {c.tabs.map((t) => (
              <Button
                key={`chat-tab-${t.id}`}
                label={`#${oneLine(t.name, 20)}${t.id !== c.workspace?.id && t.unread > 0 ? ` ${t.unread}` : ''}`}
                variant={t.id === c.workspace?.id ? 'primary' : undefined}
                onPress={() => void openRoom($, t)}
              />
            ))}
            {c.workspace && <Button key={`chat-close-${c.workspace.id}`} label=" ×" onPress={() => void closeRoom($, c.workspace!.id)} />}
            <Button key="chat-back" label=" Back" onPress={() => void closeChat($)} />
          </Box>
          {c.workspace && st.seat?.workspaceId !== c.workspace.id && <Text>{NOT_JOINED}</Text>}
          {c.status === 'offline' && c.messages.length === 0 && <Text color="yellow">Offline. Retrying.</Text>}
          {!c.workspace && <Text>No chat open.</Text>}
          {c.status === 'loading' && c.messages.length === 0 && <Text>Loading…</Text>}
          {c.status === 'ready' && c.messages.length === 0 && <Text>No messages yet.</Text>}
          {shown.map((m, i) => {
            // A photo (or the initials) once per run of messages by the same person.
            const first = i === 0 || shown[i - 1]!.who !== m.who
            const ini = initialsOf(m.mine ? (v.name ?? m.name) : m.name)
            const pic = m.photo ? ph.byWallet[bareWallet(m.photo)] : undefined
            return (
              <Box flexDirection="column">
                {newCount > 0 && m.id === c.firstNewId && <Text color={BRAND}>{`── ${newCount} new ──`}</Text>}
                <Box>
                  {first && Img && pic?.state === 'ok' && pic.png ? (
                    <Box width={AV_COLS + 1}>
                      <Img key={`av-${i}`} source={{ png: pic.png }} columns={AV_COLS} rows={1} alt={ini} />
                    </Box>
                  ) : (
                    <Text bold color={m.color ?? BRAND}>{first ? `${ini}`.padEnd(AV_COLS + 1) : ' '.repeat(AV_COLS + 1)}</Text>
                  )}
                  <Text>
                    <Text bold color={m.mine ? undefined : BRAND}>{m.name}</Text>
                    {` · ${timeOf(m.at)} · ${m.text}`}
                  </Text>
                </Box>
              </Box>
            )
          })}
          {c.send.phase === 'failed' && (
            <Box>
              <Text color="yellow">Not sent · </Text>
              <Button key="chat-retry" label="Retry" variant="primary" onPress={() => void retrySend($, mem.chat)} />
            </Box>
          )}
          {c.send.phase === 'limited' && (
            <Box>
              <Text color="yellow">{`Slow down — try again in ${c.send.seconds}s `}</Text>
              <Button key="chat-retry" label="Retry" onPress={() => void retrySend($, mem.chat)} />
            </Box>
          )}
          <Input
            key="chat-input"
            placeholder={`Message #${c.workspace?.name ?? 'chat'}…`}
            value={c.draft}
            submitLabel="send"
            onInput={(t) => void setDraft($, t)}
            onSubmit={(t) => void sendChat($, mem.chat, t)}
          />
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text bold color={BRAND}>{v.phase === 'signed-in' ? `HiveOp · ${v.name ?? 'you'}` : 'HiveOp'}</Text>
        {v.phase === 'signed-out' && (
          <Box flexDirection="column">
            <Text>Sign in with your HiveOp account.</Text>
            <Button key="sign-in" label="Sign in" variant="primary" onPress={() => void signIn($, mem)} />
          </Box>
        )}
        {v.phase === 'pairing' && (
          <Box flexDirection="column">
            <Text>Code <Text bold color={BRAND}>{v.code}</Text></Text>
            <Text>Approve it at</Text>
            <Text color={BRAND}>{v.link}</Text>
            <Button key="cancel" label="Cancel" onPress={() => void signOut($, mem)} />
          </Box>
        )}
        {v.phase === 'signed-in' && (
          <Box flexDirection="column">
            <Box>
              <Button key="open-chat" label={unreadTotal(c) > 0 ? `Chat · ${unreadTotal(c)} new` : 'Chat'} variant="primary" onPress={() => void showChat($)} />
              <Button key="home-work" label={st.busy ? 'Joining…' : 'Work here'} onPress={() => void workHere($)} />
              <Button key="home-claim" label={wk.claiming ? 'Claiming…' : 'Claim next'} onPress={() => void claimNext($)} />
            </Box>
            {st.seat && wk.loaded && (
              <Text wrap="truncate-end">
                {`${wk.ready} ready · ${wk.inProgress} in progress${wk.next ? ` · next: ${oneLine(wk.next.title, 60)}` : ''}`}
              </Text>
            )}
            {st.seat && wk.note !== '' && <Text color={BRAND}>{oneLine(wk.note, 100)}</Text>}
            {st.seat && (
              <Box>
                <Text wrap="truncate-end">{`In ${oneLine(st.seat.workspaceName, 40)} as ${oneLine(st.seat.name, 30)} `}</Text>
                <Button key="home-leave" label="Leave" onPress={() => void leaveSeat($)} />
              </Box>
            )}
            {st.note !== '' && <Text color={BRAND}>{oneLine(st.note, 100)}</Text>}
            <Button key="home-auto" label={st.auto ? 'Join automatically in matching folders: on' : 'Join automatically in matching folders: off'} onPress={() => void setAuto($, !st.auto)} />
            <Box>
              <Button key="home-workspaces" label="Workspaces" onPress={() => void goTo($, 'workspaces')} />
              <Button key="home-people" label="People" onPress={() => void goTo($, 'people')} />
              <Button key="sign-out" label="Sign out" onPress={() => void signOut($, mem)} />
            </Box>
            {nv.band === 'hidden' && <Button key="home-show-band" label="Show band" onPress={() => void setBand($, 'shown')} />}
          </Box>
        )}
        {v.phase === 'ended' && (
          <Box flexDirection="column">
            <Text color="yellow">{ENDED_TEXT[v.reason]}</Text>
            {v.reason !== 'not-open' && <Button key="retry" label="Sign in" variant="primary" onPress={() => void signIn($, mem)} />}
          </Box>
        )}
        {v.phase !== 'signed-in' && nv.band === 'hidden' && <Button key="home-show-band" label="Show band" onPress={() => void setBand($, 'shown')} />}
      </Box>
    )
  })
}

function sayText(out: SendOutcome, c: ChatView): string {
  if (out === 'sent') return 'Sent.'
  if (out === 'empty') return 'Usage: /say <message>'
  if (out === 'signed-out') return 'Sign in first: /hiveop sign-in'
  if (out === 'no-room') return 'No chat open.'
  if (out === 'limited') return `Slow down — try again in ${c.send.phase === 'limited' ? c.send.seconds : 30}s.`
  return 'Not sent. Try again.'
}

// The band's and home's Chat button: into the pane if it can be drawn, else notices.
async function showChat($: Engine) {
  const opened = await $.ui.open({ id: PANE, title: 'HiveOp' })
  await ensureLoaded($)
  if (opened.isPlaced && !(await read($, chat)).workspace) {
    await goTo($, 'workspaces')
    await setNav($, { note: 'Open a chat from a workspace.' })
    return
  }
  await setNav($, { screen: 'home' })
  if (opened.isPlaced) await openChat($)
  else await logRecent($)
}

async function signInIfAsked($: Engine, mem: Mem, view: AuthView, sub: string): Promise<AuthView> {
  // `/hiveop` alone only opens the home; `/hiveop sign-in` starts a code.
  if (sub === 'sign-in' || sub === 'signin') return signIn($, mem)
  return view
}

async function narrow($: Engine, mem: Mem, view: AuthView): Promise<string> {
  if (view.phase === 'pairing') return `HiveOp code ${view.code}. Approve at ${view.link}`
  if (view.phase === 'signed-in') {
    for (;;) {
      const nv = await read($, nav)
      const pick = await ask($, `HiveOp · ${view.name ?? 'signed in'}`, ['Chat', 'Workspaces', 'People', 'More'])
      if (pick === 'Chat') {
        await ensureLoaded($)
        await logRecent($)
        return 'Opened chat.'
      }
      if (pick === 'Workspaces') await narrowWorkspaces($)
      else if (pick === 'People') await narrowPeople($)
      else if (pick === 'More') {
        const bandWord = nv.band === 'hidden' ? 'Show band' : 'Hide band'
        const more = await ask($, 'More', [bandWord, 'Claim next', 'Sign out', 'Work here'])
        if (more === bandWord) {
          await setBand($, nv.band === 'hidden' ? 'shown' : 'hidden')
          return 'Done.'
        }
        if (more === 'Sign out') {
          await signOut($, mem)
          return 'Signed out of HiveOp on this computer.'
        }
        if (more === 'Claim next') {
          await ensureLoaded($)
          $.ui.log(`HiveOp · ${await claimNext($)}`)
          return 'Done.'
        }
        if (more === 'Work here') {
          $.ui.log(`HiveOp · ${await workHere($)}`)
          return 'Done.'
        }
        continue
      } else return `HiveOp · ${view.name ?? 'signed in'}`
      return 'Done.'
    }
  }
  const pick = await $.ui.ask(view.phase === 'ended' ? ENDED_TEXT[view.reason] + ' Sign in?' : 'HiveOp: sign in?', ['Sign in', 'Not now']).catch(
    () => 'Not now',
  )
  if (pick !== 'Sign in') return 'HiveOp: not signed in.'
  const v = await signIn($, mem)
  return v.phase === 'pairing' ? `HiveOp code ${v.code}. Approve at ${v.link}` : ENDED_TEXT[v.phase === 'ended' ? v.reason : 'unreachable']
}
