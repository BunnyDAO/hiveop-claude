import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/ada'
const KEY = 'wm_ct_SECRETKEYSECRETKEY'
const WS = 'ws-1'
const STORED = new Map([[`${HOME}/.hiveop/claude-plugin.json`, JSON.stringify({ key: KEY })]])
const BAND = { plugin: 'hiveop', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const PANE = {
  plugin: 'hiveop',
  component: 'Pane',
  requestId: 'hiveop',
  props: { title: 'HiveOp', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const SURFACES = ['terminal', 'desktop'] as const
const GAP = 3_500

type Msg = { id: string; content: string; senderDisplayName: string; senderWallet: string; createdAt: string; metadata?: Record<string, unknown> }
const MY_WALLET = 'email:user-ada'
type Reply = { status: number; body?: unknown; headers?: Record<string, string> }

type World = {
  clock: ReturnType<typeof mock.clock>
  calls: { url: string; method: string; body: string }[]
  logs: string[]
  history: Msg[]
  pending: Msg[] // delivered by the next sync
  placed: boolean
  workspaces: unknown[]
  syncReply: Reply | null // forced reply for /me/sync with a cursor
  postReply: Reply | null // forced reply for POST chat
  asked: string
  alerts: { id: string; title: string; body?: string; read: boolean; createdAt: string; type: string }[]
  notes: { text: string; title?: string }[]
  pendingAlerts: unknown[]
}

function msg(id: string, text: string, who = 'Bea', wallet = who === 'Bea' ? 'BeaWallet' : MY_WALLET, metadata?: Record<string, unknown>): Msg {
  return { id, content: text, senderDisplayName: who, senderWallet: wallet, metadata, createdAt: new Date(Date.UTC(2026, 10, 8, 12, Number(id.replace(/\D/g, '')) % 60)).toISOString() }
}

function world(on: any, start: Partial<World> = {}): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 8, 12, 0) })
  const w: World = {
    clock,
    calls: [],
    logs: [],
    history: [msg('m1', 'earlier words')],
    pending: [],
    placed: true,
    workspaces: [{ id: WS, name: 'Forge' }],
    syncReply: null,
    postReply: null,
    asked: 'Chat',
    alerts: [],
    notes: [],
    pendingAlerts: [],
    ...start,
  }
  mock.env(on, { HOME, HIVEOP_API_URL: 'https://api.test/api/v1' })
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name ?? 'hiveop' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('fs.read', (_: unknown, e: any) => {
    const t = STORED.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  // An open room, from the legacy single-workspace key: it migrates to the first tab.
  const store = new Map<string, unknown>([['chat.workspace', { id: WS, name: 'Forge' }]])
  on('store.delete', (_: unknown, e: any) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.get', (_: unknown, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: w.placed ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  on('ui.panes', () => ({ value: w.placed ? [{ id: 'hiveop', title: 'HiveOp', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', (_: unknown, e: any) => {
    w.notes.push({ text: e.text, title: e.options?.title })
    return { value: { isSent: true, channel: 'terminal' } }
  })
  on('ui.log', (_: unknown, e: any) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', (_: unknown, e: any) => {
    const method = e.init?.method ?? 'GET'
    w.calls.push({ url: e.url, method, body: e.init?.body ?? '' })
    const reply = (r: Reply) => ({ value: { status: r.status, ok: r.status < 300, headers: r.headers ?? {}, text: JSON.stringify(r.body ?? {}) } })
    const path = e.url.replace('https://api.test/api/v1', '')
    if (path.startsWith('/me/hive/profile')) return reply({ status: 200, body: { profile: { displayName: 'Ada', walletPubkey: MY_WALLET } } })
    if (path === '/workspaces') return reply({ status: 200, body: { workspaces: w.workspaces } })
    if (path === '/me/notifications/count') return reply({ status: 200, body: { success: true, count: w.alerts.filter((a) => !a.read).length } })
    if (path === '/me/notifications') return reply({ status: 200, body: { success: true, notifications: w.alerts } })
    if (path === '/me/notifications/read-all' && method === 'POST') {
      w.alerts = w.alerts.map((a) => ({ ...a, read: true }))
      return reply({ status: 200, body: { success: true } })
    }
    if (path.startsWith('/me/sync')) {
      if (!path.includes('cursor=')) return reply({ status: 200, body: { cursor: 'c0', events: [], timedOut: false } })
      if (w.syncReply) return reply(w.syncReply)
      const events: unknown[] = w.pending.map((m) => ({ type: 'workspace:chat_message', workspaceId: WS, message: m }))
      events.push(...w.pendingAlerts.map((n) => ({ type: 'notification:created', notification: n })))
      w.pending = []
      w.pendingAlerts = []
      return reply({ status: 200, body: { cursor: 'c1', events, timedOut: events.length === 0 } })
    }
    if (path.startsWith(`/workspaces/${WS}/chat`) && method === 'GET') return reply({ status: 200, body: { messages: w.history } })
    if (path === `/workspaces/${WS}/chat` && method === 'POST') {
      if (w.postReply) return reply(w.postReply)
      return reply({ status: 201, body: { message: msg('m9', JSON.parse(e.init.body).content, 'Ada') } })
    }
    return reply({ status: 404 })
  })
  return w
}

const text = async (ui: any) => JSON.stringify(await ui.drawn())
const syncs = (w: World) => w.calls.filter((c) => c.url.includes('/me/sync') && c.url.includes('cursor='))
const posts = (w: World) => w.calls.filter((c) => c.method === 'POST')
const start = async ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })


const alert = (id: string, title: string, read = false) => ({ id, title, body: 'can you look?', read, type: 'mention', createdAt: new Date(Date.UTC(2026, 10, 8, 12, 5)).toISOString() })

test('hcp-09: a mention from sync toasts and notifies once, and counts on the band', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(10)
  w.pendingAlerts = [alert('n1', 'Cy mentioned you in Forge')]
  await w.clock.advance(GAP * 2)
  expect(w.notes).toHaveLength(1)
  expect(w.notes[0]!.text).toContain('Cy mentioned you in Forge')
  w.pendingAlerts = [alert('n1', 'Cy mentioned you in Forge')]
  await w.clock.advance(GAP * 2)
  expect(w.notes).toHaveLength(1)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'band-alerts' })).toBeDefined()
  expect(await text(band)).toContain('Alerts · 1')
  await band.unmount()
})

test('hcp-09: unread from before this session count on the band; opening marks all read', async ($, on) => {
  const w = world(on, { alerts: [alert('n0', 'Bea mentioned you in Forge'), alert('n9', 'old', true)] })
  await start($)
  await w.clock.advance(10)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await text(band)).toContain('Alerts · 1')
  await band.press({ key: 'band-alerts' })
  await band.unmount()
  expect(w.calls.some((c) => c.method === 'POST' && c.url.endsWith('/me/notifications/read-all'))).toBe(true)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = await text(pane)
  expect(shown).toContain('Bea mentioned you in Forge')
  expect(shown).toContain('can you look?')
  await pane.unmount()
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ key: 'band-alerts' })).toBeUndefined()
  await after.unmount()
  expect(w.notes).toHaveLength(0) // older ones are counted, not re-notified
})

test('hcp-09: an already-read notification from sync is ignored', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(10)
  w.pendingAlerts = [alert('n2', 'seen in the app', true)]
  await w.clock.advance(GAP * 2)
  expect(w.notes).toHaveLength(0)
})
