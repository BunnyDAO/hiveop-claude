import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { AuthView, ChatMsg, ChatView, InviteRow, NavView, PilotRow, WorkView, WsRow } from '../types'
import {
  type Fetched,
  acceptInvite,
  claimIssue,
  computerName,
  declineInvite,
  fetchWorkSummary,
  fetchMe,
  followingAmong,
  forgetKey,
  hiveop,
  joinWorkspace,
  listExplore,
  listInvites,
  listMine,
  listPilots,
  loadKey,
  pollPairing,
  refusal,
  requestToJoin,
  saveKey,
  setFollow,
  startPairing,
} from './client'

const EMPTY_CHAT: ChatView = {
  workspace: null,
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
const chat = atom({ plugin: 'hiveop', key: 'chat' } as const, EMPTY_CHAT, { shape: 'chat-1' })
const EMPTY_NAV: NavView = {
  screen: 'home',
  tab: 'mine',
  band: 'shown',
  note: '',
  current: null,
  mine: null,
  invites: null,
  explore: { search: '', rows: [], offset: 0, total: 0, loaded: false },
  people: { query: '', rows: [], following: [], offset: 0, more: false, loaded: false },
}
const nav = atom({ plugin: 'hiveop', key: 'nav' } as const, EMPTY_NAV, { shape: 'nav-1' })
const EMPTY_WORK: WorkView = { workspaceId: null, loaded: false, ready: 0, inProgress: 0, next: null, note: '', claiming: false }
const work = atom({ plugin: 'hiveop', key: 'work' } as const, EMPTY_WORK, { shape: 'work-1' })

// Chat for the person's workspace, and the one sync loop that keeps it live.
// The server rate-limits at 20/min: ONE request in flight, a floor between
// requests, back off on trouble, honour Retry-After.



const PANE = 'hiveop'
const WAIT_MS = 25_000
const MIN_GAP_MS = 3_500
const MAX_BACKOFF_MS = 60_000
const HISTORY = 40
const KEEP = 200
const STORE_WS = 'chat.workspace'

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
  return { id, name, text, at, mine }
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

type Picked = { state: 'ok'; ws: { id: string; name: string } } | { state: 'none' } | { state: 'failed'; r: Fetched | null }

/** The stored choice if it still exists, else the person's first workspace. */
async function pickWorkspace($: Engine): Promise<Picked> {
  const r = await hiveop($, '/workspaces')
  if (!r || !r.ok) return { state: 'failed', r }
  const list = Array.isArray(r.body?.workspaces) ? (r.body!.workspaces as Array<Record<string, unknown>>) : []
  const rows = list.filter((w) => str(w.id)).map((w) => ({ id: str(w.id), name: str(w.name) || str(w.title) || 'workspace' }))
  if (rows.length === 0) return { state: 'none' }
  const stored = (await $.store.get(STORE_WS)) as { id?: unknown } | undefined
  const hit = rows.find((w) => w.id === stored?.id)
  const ws = hit ?? rows[0]!
  if (!hit) await $.store.set(STORE_WS, ws)
  return { state: 'ok', ws }
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

/** Make sure a room and its recent messages are in the view; one fetch when they are not. */
async function ensureLoaded($: Engine): Promise<void> {
  const v = await read($, chat)
  if (v.workspace && v.messages.length > 0) return
  const p = await pickWorkspace($)
  if (p.state === 'none') {
    await update($, chat, (c) => ({ ...c, workspace: null, status: 'no-workspace' }) as ChatView)
    return
  }
  if (p.state === 'failed') {
    await update($, chat, (c) => ({ ...c, status: 'offline' }) as ChatView)
    return
  }
  const h = await loadHistory($, p.ws.id, v.me)
  if ('r' in h) {
    await update($, chat, (c) => ({ ...c, workspace: p.ws, status: 'offline' }) as ChatView)
    return
  }
  await update($, chat, (c) => ({ ...c, workspace: p.ws, status: 'ready', messages: merge(c.workspace?.id === p.ws.id ? c.messages : [], h.msgs) }) as ChatView)
  await refreshWork($)
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
  let v = await read($, chat)
  if (!v.workspace) {
    await ensureLoaded($)
    v = await read($, chat)
  }
  if (!v.workspace) return v.status === 'no-workspace' ? 'no-room' : 'failed'
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
  const sent = posted ? { ...posted, name: SELF_LABEL, mine: true } : null
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

/** Find the room, take the head cursor, load recent history. Returns the delay before the next step. */
async function bootstrap($: Engine, mem: ChatMem): Promise<number> {
  const p = await pickWorkspace($)
  if (p.state === 'none') {
    await update($, chat, (c) => ({ ...c, workspace: null, status: 'no-workspace' }) as ChatView)
    return 60_000
  }
  if (p.state === 'failed') return failed($, mem, p.r)
  const head = await hiveop($, `/me/sync?clientId=${mem.clientId}`)
  if (!head || !head.ok || typeof head.body?.cursor !== 'string') return failed($, mem, head)
  const me = (await read($, chat)).me
  const h = await loadHistory($, p.ws.id, me)
  if ('r' in h) return failed($, mem, h.r)
  mem.cursor = head.body.cursor
  mem.failures = 0
  await update($, chat, (c) => ({
    ...c,
    workspace: p.ws,
    status: 'ready',
    messages: merge(c.workspace?.id === p.ws.id ? c.messages : [], h.msgs),
    unread: c.workspace?.id === p.ws.id ? c.unread : 0,
  }) as ChatView)
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
  for (const ev of events) {
    if (ev.type !== 'workspace:chat_message' || ev.workspaceId !== v.workspace?.id) continue
    const m = toMsg(ev.message, v.me)
    if (m) incoming.push(m)
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

/** Fetch the current workspace's counts and next item. Overlapping calls fold into one more fetch. */
async function refreshWork($: Engine, keepNote = false): Promise<void> {
  if (workRun.inflight) {
    workRun.dirty = true
    return
  }
  workRun.inflight = true
  try {
    do {
      workRun.dirty = false
      const wsId = (await read($, chat)).workspace?.id ?? null
      if (!wsId) {
        await update($, work, () => EMPTY_WORK)
        continue
      }
      const out = await fetchWorkSummary($, wsId)
      if ((await read($, chat)).workspace?.id !== wsId) {
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
  const wsId = (await read($, chat)).workspace?.id
  if (!wsId) return 'No workspace yet.'
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
    }
  } catch {
    note = "Couldn't reach HiveOp."
  }
  await setWork($, { claiming: false, note })
  await refreshWork($, true)
  $.ui.toast(`HiveOp · ${note}`)
  return note
}

function workKind(ev: Record<string, unknown>, status: string): 'new' | 'claimed' | 'done' | null {
  if (status === 'closed') return 'done'
  if (ev.action === 'create') return 'new'
  if (ev.action === 'claim') return 'claimed'
  return null
}

/** Toasts for what changed (at most three at once), and a fresh summary when it touched the current workspace. */
async function onWorkEvents($: Engine, events: Array<Record<string, unknown>>, me: string | null): Promise<void> {
  const cur = (await read($, chat)).workspace?.id
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

/** Recent lines as transcript notices: drawn for the person, not sent to the model. */
async function logRecent($: Engine, count = 10): Promise<void> {
  const v = await read($, chat)
  if (v.status === 'no-workspace') {
    $.ui.log('HiveOp chat · no workspace yet')
    return
  }
  if (v.status === 'offline' && v.messages.length === 0) {
    $.ui.log("HiveOp chat · couldn't reach HiveOp")
    return
  }
  $.ui.log(`HiveOp chat · #${v.workspace?.name ?? ''}`)
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
  const c = await read($, chat)
  const stored = (await $.store.get(STORE_WS)) as { id?: unknown } | undefined
  const pick = [c.workspace?.id, typeof stored?.id === 'string' ? stored.id : undefined].find((id) => id && out.rows.some((w) => w.id === id))
  await setNav($, { mine: out.rows, current: pick ?? out.rows[0]?.id ?? null })
}

/** Make this the workspace the chat and the band follow. The sync loop is global and carries on. */
async function chooseWorkspace($: Engine, ws: WsRow): Promise<void> {
  const ref = { id: ws.id, name: ws.name }
  await $.store.set(STORE_WS, ref)
  await setNav($, { current: ws.id, note: `Now in ${ws.name}.` })
  const before = await read($, chat)
  if (before.workspace?.id === ws.id) return
  await update($, chat, (c) => ({ ...c, workspace: ref, status: 'loading', messages: [], unread: 0, firstNewId: null, draft: '', send: { phase: 'idle' } }) as ChatView)
  await update($, work, () => EMPTY_WORK)
  void refreshWork($)
  const h = await loadHistory($, ws.id, before.me)
  if ((await read($, chat)).workspace?.id !== ws.id) return // chosen again while this was out
  if ('r' in h) {
    await update($, chat, (c) => ({ ...c, status: 'offline' }) as ChatView)
    return
  }
  await update($, chat, (c) => ({ ...c, status: 'ready', messages: merge([], h.msgs) }) as ChatView)
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
      const got = await pickFrom($, 'Use which workspace?', rows.map((w) => (w.id === n.current ? `${w.name} · current` : w.name)))
      if (got && 'item' in got) {
        await chooseWorkspace($, rows[got.item]!)
        await say($)
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
  startChat($, mem.chat)
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
  stopPolling(mem)
  stopChat(mem.chat)
  await forgetKey($)
  await update($, auth, () => ({ phase: 'signed-out' }) as AuthView)
  await update($, chat, () => EMPTY_CHAT)
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
    await restore($, mem)
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
    if (nv.band === 'hidden') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text wrap="truncate-end">
          <Text color={BRAND} bold>HiveOp</Text>
          {bandText(v)}
          {v.phase === 'signed-in' && c.unread > 0 && <Text bold color={BRAND}>{` · ${c.unread} new`}</Text>}
          {v.phase === 'signed-in' && workText(wk)}
          {v.phase === 'signed-in' && wk.note !== '' && ` · ${oneLine(wk.note, 70)}`}
        </Text>
        {(v.phase === 'signed-out' || v.phase === 'ended') && (
          <Button key="band-sign-in" label=" Sign in" onPress={() => void signIn($, mem)} />
        )}
        {v.phase === 'signed-in' && <Button key="band-chat" label=" Chat" onPress={() => void showChat($)} />}
        {v.phase === 'signed-in' && wk.loaded && wk.ready > 0 && (
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
    const { Box, Button, Input, Text } = $.ui.resolve(e)
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
                <Text bold={w.id === nv.current} color={w.id === nv.current ? BRAND : undefined}>{`${w.id === nv.current ? '● ' : '  '}${w.name}`}</Text>
                {w.id !== nv.current && <Button key={`ws-use-${w.id}`} label=" Use" onPress={() => void chooseWorkspace($, w)} />}
                {w.id === nv.current && <Text>{' · current'}</Text>}
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
            <Text bold color={BRAND}>{`#${c.workspace?.name ?? 'chat'}`}</Text>
            <Button key="chat-back" label=" Back" onPress={() => void closeChat($)} />
          </Box>
          {c.status === 'offline' && c.messages.length === 0 && <Text color="yellow">Offline. Retrying.</Text>}
          {c.status === 'no-workspace' && <Text>No workspace yet. Create one at app.hiveop.io.</Text>}
          {c.status === 'loading' && c.messages.length === 0 && <Text>Loading…</Text>}
          {c.status === 'ready' && c.messages.length === 0 && <Text>No messages yet.</Text>}
          {shown.map((m) => (
            <Box flexDirection="column">
              {newCount > 0 && m.id === c.firstNewId && <Text color={BRAND}>{`── ${newCount} new ──`}</Text>}
              <Text>
                <Text bold color={m.mine ? undefined : BRAND}>{m.name}</Text>
                {` · ${timeOf(m.at)} · ${m.text}`}
              </Text>
            </Box>
          ))}
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
              <Button key="open-chat" label={c.unread > 0 ? `Chat · ${c.unread} new` : 'Chat'} variant="primary" onPress={() => void showChat($)} />
              <Button key="home-work" label="Work here · soon" onPress={() => $.ui.toast('Work here is coming soon')} />
              <Button key="home-claim" label={wk.claiming ? 'Claiming…' : 'Claim next'} onPress={() => void claimNext($)} />
            </Box>
            {wk.loaded && (
              <Text wrap="truncate-end">
                {`${wk.ready} ready · ${wk.inProgress} in progress${wk.next ? ` · next: ${oneLine(wk.next.title, 60)}` : ''}`}
              </Text>
            )}
            {wk.note !== '' && <Text color={BRAND}>{oneLine(wk.note, 100)}</Text>}
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
  if (out === 'no-room') return 'No workspace yet.'
  if (out === 'limited') return `Slow down — try again in ${c.send.phase === 'limited' ? c.send.seconds : 30}s.`
  return 'Not sent. Try again.'
}

// The band's and home's Chat button: into the pane if it can be drawn, else notices.
async function showChat($: Engine) {
  const opened = await $.ui.open({ id: PANE, title: 'HiveOp' })
  await ensureLoaded($)
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
        const more = await ask($, 'More', [bandWord, 'Claim next', 'Sign out', 'Work here · soon'])
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
        if (more === 'Work here · soon') $.ui.log('Coming soon.')
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
