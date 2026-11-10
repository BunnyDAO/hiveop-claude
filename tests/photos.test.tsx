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
type Reply = { status: number; body?: unknown; headers?: Record<string, string>; text?: string }

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
  photos: Record<string, Reply>
  photoCalls: string[]
}

function msg(id: string, text: string, who = 'Bea', wallet = who === 'Bea' ? 'BeaWallet' : MY_WALLET, metadata?: Record<string, unknown>): Msg {
  return { id, content: text, senderDisplayName: who, senderWallet: wallet, metadata, createdAt: new Date(Date.UTC(2026, 10, 8, 12, Number(id.replace(/\D/g, '')) % 60)).toISOString() }
}

function path0(u: string): string {
  return u.replace('https://api.test/api/v1', '')
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
    photos: {},
    photoCalls: [],
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
    const reply = (r: Reply) => ({ value: { status: r.status, ok: r.status < 300, headers: r.headers ?? {}, text: r.text ?? JSON.stringify(r.body ?? {}) } })
    if (path0(e.url).includes('/avatar.png')) {
      const who = decodeURIComponent(path0(e.url).split('/users/')[1]!.split('/avatar.png')[0]!)
      w.photoCalls.push(who)
      const r = w.photos[who]
      return reply(r ?? { status: 404 })
    }
    const path = e.url.replace('https://api.test/api/v1', '')
    if (path.startsWith('/me/hive/profile')) return reply({ status: 200, body: { profile: { displayName: 'Ada', walletPubkey: MY_WALLET } } })
    if (path === '/workspaces') return reply({ status: 200, body: { workspaces: w.workspaces } })
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
const start = async ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const OK: Reply = { status: 200, text: PNG }
const room = (...m: Msg[]) => ({ history: m })
const open = async ($: any, w: World) => {
  await start($)
  await $.command.run({ command: 'hiveop', args: 'chat', ...RUN })
  await w.clock.advance(50)
}
const shownOn = async ($: any, w: World, surface: 'terminal' | 'desktop') => {
  const pane = await $.ui.mount({ ...PANE, surface })
  await w.clock.advance(50)
  const out = await text(pane)
  await pane.unmount()
  return out
}
const count = (hay: string, needle: string) => hay.split(needle).length - 1

test('terminal: a photo once per run of messages, initials as its alt text', async ($, on) => {
  const w = world(on, {
    ...room(msg('m1', 'one', 'Bea Lee', 'BeaWallet'), msg('m2', 'two', 'Bea Lee', 'BeaWallet'), msg('m3', 'three', 'Cy Doe', 'CyWallet')),
    photos: { BeaWallet: OK, CyWallet: OK },
  })
  await open($, w)
  await shownOn($, w, 'terminal') // first mount asks for the photos
  const out = await shownOn($, w, 'terminal')
  expect(out).toContain('Image')
  expect(count(out, '"alt":"BL"')).toBe(1) // Bea's two lines share one photo
  expect(count(out, '"alt":"CD"')).toBe(1)
})

test('your own messages carry your own photo', async ($, on) => {
  const w = world(on, { ...room(msg('m1', 'mine', 'Ada', MY_WALLET)), photos: { [MY_WALLET]: OK } })
  await open($, w)
  await shownOn($, w, 'terminal')
  const out = await shownOn($, w, 'terminal')
  expect(w.photoCalls).toContain(MY_WALLET)
  expect(out).toContain('"alt":"A"')
  expect(out).toContain('You')
})

test('desktop: coloured initials, never an Image, and no photo bytes shown', async ($, on) => {
  const w = world(on, {
    ...room(msg('m1', 'one', 'Bea Lee', 'BeaWallet'), msg('m2', 'two', 'Bea Lee', 'BeaWallet')),
    photos: { BeaWallet: OK },
  })
  await open($, w)
  await shownOn($, w, 'desktop')
  const out = await shownOn($, w, 'desktop')
  expect(out).not.toContain('Image')
  expect(out).not.toContain(PNG)
  expect(count(out, 'BL')).toBe(1)
  expect(out).toContain('#22D3EE')
})

test('a missing or failed photo falls back to initials on the terminal', async ($, on) => {
  const w = world(on, {
    ...room(msg('m1', 'one', 'Bea Lee', 'BeaWallet'), msg('m2', 'two', 'Cy Doe', 'CyWallet')),
    photos: { BeaWallet: { status: 404 }, CyWallet: { status: 500 } },
  })
  await open($, w)
  await shownOn($, w, 'terminal')
  const out = await shownOn($, w, 'terminal')
  expect(out).not.toContain('Image')
  expect(out).toContain('BL')
  expect(out).toContain('CD')
})

test('garbage bytes are treated as no photo', async ($, on) => {
  const w = world(on, { ...room(msg('m1', 'one', 'Bea Lee', 'BeaWallet')), photos: { BeaWallet: { status: 200, text: '<html>nope</html>' } } })
  await open($, w)
  await shownOn($, w, 'terminal')
  expect(await shownOn($, w, 'terminal')).not.toContain('Image')
})

test('each person is fetched once per session, failures included, across surfaces and redraws', async ($, on) => {
  const w = world(on, {
    ...room(msg('m1', 'one', 'Bea Lee', 'BeaWallet'), msg('m2', 'two', 'Cy Doe', 'CyWallet')),
    photos: { BeaWallet: OK, CyWallet: { status: 404 } },
  })
  await open($, w)
  for (const s of ['terminal', 'desktop', 'terminal', 'desktop'] as const) await shownOn($, w, s)
  await w.clock.advance(GAP * 3)
  expect(w.photoCalls.filter((x) => x === 'BeaWallet')).toHaveLength(1)
  expect(w.photoCalls.filter((x) => x === 'CyWallet')).toHaveLength(1)
})

test('a new message from someone already seen does not refetch', async ($, on) => {
  const w = world(on, { ...room(msg('m1', 'one', 'Bea Lee', 'BeaWallet')), photos: { BeaWallet: OK } })
  await open($, w)
  await shownOn($, w, 'terminal')
  w.pending = [msg('m2', 'later', 'Bea Lee', 'BeaWallet')]
  await w.clock.advance(GAP * 2)
  await shownOn($, w, 'terminal')
  expect(w.photoCalls.filter((x) => x === 'BeaWallet')).toHaveLength(1)
})

test('photos never reach command output or the prompt', async ($, on) => {
  const w = world(on, { ...room(msg('m1', 'SECRET-ONE', 'Bea Lee', 'BeaWallet')), photos: { BeaWallet: OK } })
  await open($, w)
  await shownOn($, w, 'terminal')
  const outs = [
    await $.command.run({ command: 'hiveop', args: '', ...RUN }),
    await $.command.run({ command: 'hiveop', args: 'chat', ...RUN }),
    await $.command.run({ command: 'say', args: 'hi', ...RUN }),
  ]
  const all = JSON.stringify(outs)
  expect(all).not.toContain(PNG)
  expect(all).not.toContain('Bea')
  expect(all).not.toContain('BL')
})
