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
    if (path.startsWith('/chat/global') && method === 'GET') return reply({ status: 200, body: { messages: [{ id: 'g1', senderWallet: 'CyWallet', senderName: 'Cy', content: 'hello world room', createdAt: new Date(Date.UTC(2026, 10, 8, 12, 1)).toISOString() }] } })
    if (path === '/chat/global' && method === 'POST') return reply({ status: 200, body: { message: { id: 'g9', senderWallet: MY_WALLET, senderName: 'Ada', content: JSON.parse(e.init.body).content, createdAt: new Date().toISOString() } } })
    if (path === '/me/swarms') return reply({ status: 200, body: { swarms: [{ id: 'sw-1', name: 'Bees' }] } })
    if (path === '/swarms/sw-1/channels') return reply({ status: 200, body: { channels: [{ id: 'ch-gen', name: 'general' }, { id: 'ch-staff', name: 'staff', viewPolicy: 'admins' }] } })
    if (path.startsWith('/swarms/sw-1/chat') && method === 'GET') return reply({ status: 200, body: { messages: [{ id: 's1', channelId: 'ch-gen', senderWallet: 'BeaWallet', senderDisplayName: 'Bea', content: 'swarm words', createdAt: new Date(Date.UTC(2026, 10, 8, 12, 2)).toISOString() }] } })
    if (path === '/swarms/sw-1/chat' && method === 'POST') return reply({ status: 201, body: { message: { id: 's9', channelId: 'ch-gen', senderWallet: MY_WALLET, content: JSON.parse(e.init.body).content, createdAt: new Date().toISOString() } } })
    if (path === '/reports' && method === 'POST') return reply({ status: 201, body: { success: true } })
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


const home = async ($: any, w: World) => {
  await start($)
  await w.clock.advance(10)
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}
const call = (w: World, method: string, p: string) => w.calls.filter((c) => c.method === method && c.url.replace('https://api.test/api/v1', '').startsWith(p))

test('hcp-07: Global opens as a tab, reads history, posts as the person', async ($, on) => {
  const w = world(on)
  const pane = await home($, w)
  await pane.press({ key: 'home-global' })
  const shown = await text(pane)
  expect(shown).toContain('#Global')
  expect(shown).toContain('hello world room')
  await pane.input({ key: 'chat-input', text: 'hi everyone' })
  const sent = call(w, 'POST', '/chat/global')
  expect(sent).toHaveLength(1)
  expect(JSON.parse(sent[0]!.body)).toEqual({ content: 'hi everyone' })
  expect(await text(pane)).toContain('hi everyone')
  await pane.unmount()
})

test('hcp-07: Swarm lists the channels the person may see and opens one as a tab', async ($, on) => {
  const w = world(on)
  const pane = await home($, w)
  await pane.press({ key: 'home-swarm' })
  const list = await text(pane)
  expect(list).toContain('#general')
  expect(list).toContain('#staff')
  await pane.press({ key: 'swarm-open-ch-gen' })
  const shown = await text(pane)
  expect(shown).toContain('#general')
  expect(shown).toContain('swarm words')
  expect(call(w, 'GET', '/swarms/sw-1/chat').some((c) => c.url.includes('channelId=ch-gen'))).toBe(true)
  expect(shown).not.toContain('To code in it') // the workspace seat note is for workspace rooms only
  await pane.input({ key: 'chat-input', text: 'buzz' })
  const sent = call(w, 'POST', '/swarms/sw-1/chat')
  expect(JSON.parse(sent[0]!.body)).toEqual({ content: 'buzz', channelId: 'ch-gen' })
  await pane.unmount()
})

test('hcp-07: sync routes swarm and Global lines to their tabs', async ($, on) => {
  const w = world(on)
  const pane = await home($, w)
  await pane.press({ key: 'home-global' })
  w.pendingRaw = [
    { type: 'global:chat_message', message: { id: 'g2', senderWallet: 'CyWallet', senderName: 'Cy', content: 'live global', createdAt: new Date().toISOString() } },
    { type: 'swarm:chat_message', swarmId: 'sw-1', channelId: 'ch-gen', message: { id: 's2', channelId: 'ch-gen', senderWallet: 'BeaWallet', senderDisplayName: 'Bea', content: 'live swarm', createdAt: new Date().toISOString() } },
  ]
  await w.clock.advance(GAP * 2)
  expect(await text(pane)).toContain('live global')
  expect(await text(pane)).not.toContain('live swarm')
  await pane.unmount()
})

test('hcp-07: reporting a Global message files global_message', async ($, on) => {
  const w = world(on)
  const pane = await home($, w)
  await pane.press({ key: 'home-global' })
  await pane.press({ key: 'msg-act-g1' })
  await pane.press({ key: 'msg-report' })
  await pane.press({ key: 'report-spam' })
  await pane.press({ key: 'report-confirm' })
  const r = call(w, 'POST', '/reports')
  expect(JSON.parse(r[0]!.body)).toEqual({ targetKind: 'global_message', targetId: 'g1', reason: 'spam' })
  await pane.unmount()
})
