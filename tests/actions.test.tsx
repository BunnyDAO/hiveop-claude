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
  blocks: { wallet: string; kind: string }[]
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
    blocks: [],
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
    if (path === '/me/blocks') return reply({ status: 200, body: { success: true, blocks: w.blocks } })
    if (path.startsWith('/me/blocks/') && method === 'POST') return reply({ status: 200, body: { success: true } })
    if (path === '/reports' && method === 'POST') return reply({ status: 201, body: { success: true } })
    if (path.startsWith('/me/sync')) {
      if (!path.includes('cursor=')) return reply({ status: 200, body: { cursor: 'c0', events: [], timedOut: false } })
      if (w.syncReply) return reply(w.syncReply)
      const events = w.pending.map((m) => ({ type: 'workspace:chat_message', workspaceId: WS, message: m }))
      w.pending = []
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


const openPane = async ($: any, w: World) => {
  await start($)
  await w.clock.advance(10)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-chat' })
  await band.unmount()
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}
const postsTo = (w: World, p: string) => w.calls.filter((c) => c.method === 'POST' && c.url.endsWith(p))

test('hcp-08: each other person\'s message has ⋯ with Reply, Mute, Block, Report; mine has none', async ($, on) => {
  const w = world(on, { history: [msg('m1', 'earlier words'), msg('m2', 'my words', 'Ada')] })
  const pane = await openPane($, w)
  expect(await pane.find({ key: 'msg-act-m1' })).toBeDefined()
  expect(await pane.find({ key: 'msg-act-m2' })).toBeUndefined()
  await pane.press({ key: 'msg-act-m1' })
  for (const k of ['msg-reply', 'msg-mute', 'msg-block', 'msg-report', 'msg-cancel']) expect(await pane.find({ key: k })).toBeDefined()
  await pane.press({ key: 'msg-cancel' })
  expect(await pane.find({ key: 'msg-reply' })).toBeUndefined()
  await pane.unmount()
})

test('hcp-08: Reply quotes into the input', async ($, on) => {
  const w = world(on)
  const pane = await openPane($, w)
  await pane.press({ key: 'msg-act-m1' })
  await pane.press({ key: 'msg-reply' })
  const input = await pane.find({ key: 'chat-input' })
  expect(JSON.stringify(input)).toContain('@Bea')
  expect(JSON.stringify(input)).toContain('earlier words')
  expect(postsTo(w, '/chat')).toHaveLength(0)
  await pane.unmount()
})

test('hcp-08: Block hides that person now and later, server-side too', async ($, on) => {
  const w = world(on, { history: [msg('m1', 'earlier words'), msg('m3', 'more from bea')] })
  const pane = await openPane($, w)
  await pane.press({ key: 'msg-act-m1' })
  await pane.press({ key: 'msg-block' })
  const b = postsTo(w, '/me/blocks/BeaWallet')
  expect(b).toHaveLength(1)
  expect(JSON.parse(b[0]!.body)).toEqual({ kind: 'block' })
  const shown = await text(pane)
  expect(shown).not.toContain('earlier words')
  expect(shown).not.toContain('more from bea')
  w.pending = [msg('m4', 'still talking', 'Bea')]
  await w.clock.advance(GAP * 2)
  expect(await text(pane)).not.toContain('still talking')
  await pane.unmount()
})

test('hcp-08: Mute sends kind mute', async ($, on) => {
  const w = world(on)
  const pane = await openPane($, w)
  await pane.press({ key: 'msg-act-m1' })
  await pane.press({ key: 'msg-mute' })
  expect(JSON.parse(postsTo(w, '/me/blocks/BeaWallet')[0]!.body)).toEqual({ kind: 'mute' })
  await pane.unmount()
})

test('hcp-08: people already blocked in the app are hidden from the start', async ($, on) => {
  const w = world(on, { blocks: [{ wallet: 'BeaWallet', kind: 'mute' }] })
  const pane = await openPane($, w)
  expect(await text(pane)).not.toContain('earlier words')
  await pane.unmount()
})

test('hcp-08: Report asks a reason, confirms once, and files a workspace_message report', async ($, on) => {
  const w = world(on)
  const pane = await openPane($, w)
  await pane.press({ key: 'msg-act-m1' })
  await pane.press({ key: 'msg-report' })
  for (const k of ['report-spam', 'report-abuse', 'report-other']) expect(await pane.find({ key: k })).toBeDefined()
  await pane.press({ key: 'report-abuse' })
  expect(postsTo(w, '/reports')).toHaveLength(0)
  await pane.press({ key: 'report-confirm' })
  const r = postsTo(w, '/reports')
  expect(r).toHaveLength(1)
  expect(JSON.parse(r[0]!.body)).toEqual({ targetKind: 'workspace_message', targetId: 'm1', reason: 'abuse' })
  expect(await pane.find({ key: 'report-confirm' })).toBeUndefined()
  await pane.unmount()
})
