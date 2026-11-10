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
  online: string[]
  pendingRaw: unknown[]
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
    online: ['BeaWallet'],
    pendingRaw: [],
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
    if (path === `/workspaces/${WS}/members`) {
      return reply({ status: 200, body: { success: true, members: [
        { walletPubkey: MY_WALLET, displayName: 'Ada' },
        { walletPubkey: 'BeaWallet', displayName: 'Bea' },
        { walletPubkey: 'CyWallet', displayName: 'Cy' },
      ] } })
    }
    if (path.startsWith('/presence?wallets=')) {
      const asked = decodeURIComponent(path.split('=')[1]!).split(',')
      return reply({ status: 200, body: { success: true, online: Object.fromEntries(asked.map((x) => [x, w.online.includes(x)])) } })
    }
    if (path.startsWith('/me/sync')) {
      if (!path.includes('cursor=')) return reply({ status: 200, body: { cursor: 'c0', events: [], timedOut: false } })
      if (w.syncReply) return reply(w.syncReply)
      const events: unknown[] = w.pending.map((m) => ({ type: 'workspace:chat_message', workspaceId: WS, message: m }))
      events.push(...w.pendingRaw)
      w.pending = []
      w.pendingRaw = []
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


const presenceReads = (w: World) => w.calls.filter((c) => c.url.includes('/presence?wallets='))
const openPane = async ($: any, w: World) => {
  await start($)
  await w.clock.advance(10)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-chat' })
  await band.unmount()
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

test('hcp-18: the chat header shows who else is online in the room', async ($, on) => {
  const w = world(on)
  const pane = await openPane($, w)
  const shown = await text(pane)
  expect(shown).toContain('1 online')
  expect(shown).toContain('Bea')
  expect(shown).not.toContain('Cy')
  const asked = decodeURIComponent(presenceReads(w)[0]!.url.split('=')[1]!)
  expect(asked.split(',')).not.toContain(MY_WALLET)
  await pane.unmount()
})

test('hcp-18: a presence change from sync refreshes the list', async ($, on) => {
  const w = world(on)
  const pane = await openPane($, w)
  const before = presenceReads(w).length
  w.online = ['BeaWallet', 'CyWallet']
  w.pendingRaw = [{ type: 'workspace:presence_changed', workspaceId: WS }]
  await w.clock.advance(GAP * 2)
  expect(presenceReads(w).length).toBe(before + 1)
  expect(await text(pane)).toContain('2 online')
  await pane.unmount()
})

test('hcp-18: another room\'s presence change does not refetch', async ($, on) => {
  const w = world(on)
  const pane = await openPane($, w)
  const before = presenceReads(w).length
  w.pendingRaw = [{ type: 'workspace:presence_changed', workspaceId: 'ws-other' }]
  await w.clock.advance(GAP * 2)
  expect(presenceReads(w).length).toBe(before)
  await pane.unmount()
})
