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

test('signed in: opens the saved room, loads history, then syncs one request at a time', async ($, on) => {
  const w = world(on, { /* keyed in below */ })
  STORED.size // key present for every test
  await start($)
  await w.clock.advance(10)
  const urls = w.calls.map((c) => c.url.replace('https://api.test/api/v1', ''))
  expect(urls).not.toContain('/workspaces') // no room is picked for you
  expect(urls.some((u) => u.startsWith('/me/sync?clientId='))).toBe(true)
  expect(urls.some((u) => u.startsWith(`/workspaces/${WS}/chat?limit=`))).toBe(true)
  await w.clock.advance(60_000)
  const s = syncs(w)
  expect(s.length).toBeGreaterThan(2)
  expect(s.length).toBeLessThanOrEqual(Math.ceil(60_000 / GAP) + 1) // never faster than the floor
  expect(s[0]!.url).toContain('waitMs=25000')
  expect(s[0]!.url).toContain('cursor=c0')
})

test('a new message shows on the band, then clears when the chat is viewed, with the marker', async ($, on) => {
  const w = world(on)
  await start($)
  w.pending = [msg('m2', 'fresh words', 'Bea')]
  await w.clock.advance(GAP * 2)
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await text(band)).toContain('1 new')
    expect(await band.find({ key: 'band-chat' })).toBeDefined()
    await band.unmount()
  }
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-chat' })
  await band.unmount()
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    const shown = await text(pane)
    expect(shown).toContain('#Forge')
    expect(shown).toContain('fresh words')
    expect(shown).toContain('── 1 new ──')
    expect(shown).toContain('Bea')
    expect(shown).toContain('earlier words')
    await pane.unmount()
  }
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await text(after)).not.toContain('new')
  await after.unmount()
})

test('Enter sends as the person; empty does nothing', async ($, on) => {
  const w = world(on)
  await start($)
  await $.command.run({ command: 'hiveop', args: 'chat', ...RUN })
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    const before = posts(w).length
    await pane.input({ key: 'chat-input', text: '   ' })
    expect(posts(w)).toHaveLength(before)
    await pane.input({ key: 'chat-input', text: 'hello team' })
    expect(posts(w)).toHaveLength(before + 1)
    await pane.unmount()
  }
  expect(posts(w)).toHaveLength(2)
  expect(JSON.parse(posts(w)[0]!.body)).toEqual({ content: 'hello team' })
})

test('a failed send says Not sent and Retry sends it again', async ($, on) => {
  const w = world(on, { postReply: { status: 500 } })
  await start($)
  await $.command.run({ command: 'hiveop', args: 'chat', ...RUN })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.input({ key: 'chat-input', text: 'try me' })
  expect(await text(pane)).toContain('Not sent')
  w.postReply = null
  await pane.press({ key: 'chat-retry' })
  expect(posts(w)).toHaveLength(2)
  expect(JSON.parse(posts(w)[1]!.body)).toEqual({ content: 'try me' })
  const shown = await text(pane)
  expect(shown).not.toContain('Not sent')
  expect(shown).toContain('try me')
  await pane.unmount()
})

test('a 429 says how long to wait', async ($, on) => {
  world(on, { postReply: { status: 429, headers: { 'Retry-After': '7' } } })
  await start($)
  await $.command.run({ command: 'hiveop', args: 'chat', ...RUN })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.input({ key: 'chat-input', text: 'too fast' })
  expect(await text(pane)).toContain('Slow down — try again in 7s')
  await pane.unmount()
})

test('narrow window: recent messages are transcript notices, commands reply neutrally', async ($, on) => {
  const w = world(on, { placed: false, history: [msg('m1', 'SECRET-ONE'), msg('m2', 'SECRET-TWO')] })
  await start($)
  const out = await $.command.run({ command: 'hiveop', args: 'chat', ...RUN })
  expect(w.logs.join('\n')).toContain('SECRET-ONE')
  expect(w.logs.join('\n')).toContain('SECRET-TWO')
  expect(JSON.stringify(out)).not.toContain('SECRET')
  expect(JSON.stringify(out)).toContain('Opened chat.')
  const picked = await $.command.run({ command: 'hiveop', args: '', ...RUN })
  expect(JSON.stringify(picked)).not.toContain('SECRET')
})

for (const placed of [true, false]) {
  test(`no command output ever carries message content (pane ${placed ? 'placed' : 'too narrow'})`, async ($, on) => {
    const w = world(on, { placed, history: [msg('m1', 'SECRET-ONE')], pending: [msg('m2', 'SECRET-TWO')] })
    await start($)
    await w.clock.advance(GAP * 2)
    const outs = [
      await $.command.run({ command: 'hiveop', args: '', ...RUN }),
      await $.command.run({ command: 'hiveop', args: 'chat', ...RUN }),
      await $.command.run({ command: 'say', args: 'hi there', ...RUN }),
      await $.command.run({ command: 'say', args: '', ...RUN }),
    ]
    expect(JSON.stringify(outs)).not.toContain('SECRET')
    expect(JSON.stringify(outs)).toContain('Sent.')
  })
}

test('/say posts to the room, and says so neutrally', async ($, on) => {
  const w = world(on)
  await start($)
  const out = await $.command.run({ command: 'say', args: 'ship it', ...RUN })
  expect(JSON.stringify(out)).toContain('Sent.')
  expect(JSON.stringify(out)).not.toContain('ship it')
  expect(JSON.parse(posts(w)[0]!.body)).toEqual({ content: 'ship it' })
})

test('trouble backs off', async ($, on) => {
  const w = world(on)
  await start($)
  w.syncReply = { status: 500 }
  await w.clock.advance(GAP + 200)
  const n = syncs(w).length
  await w.clock.advance(400)
  expect(syncs(w).length).toBe(n) // not again at once
})

test('a 429 on sync waits out Retry-After', async ($, on) => {
  const w = world(on)
  await start($)
  w.syncReply = { status: 429, headers: { 'Retry-After': '40' } }
  await w.clock.advance(GAP + 200)
  const n = syncs(w).length
  await w.clock.advance(35_000)
  expect(syncs(w).length).toBe(n)
  await w.clock.advance(10_000)
  expect(syncs(w).length).toBe(n + 1)
})

test('signing out stops the loop', async ($, on) => {
  const w = world(on)
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'sign-out' })
  const before = w.calls.length
  await w.clock.advance(120_000)
  expect(w.calls.length).toBe(before)
  await pane.unmount()
})

test('signed out: /say asks to sign in and sends nothing', async ($, on) => {
  const w = world(on)
  STORED.clear()
  try {
    await start($)
    const out = await $.command.run({ command: 'say', args: 'hi', ...RUN })
    expect(JSON.stringify(out)).toContain('Sign in first')
    expect(posts(w)).toHaveLength(0)
  } finally {
    STORED.set(`${HOME}/.hiveop/claude-plugin.json`, JSON.stringify({ key: KEY }))
  }
})

test('your own lines read "You", matched by account, never by name; your agents keep their names', async ($, on) => {
  world(on, {
    history: [
      msg('m1', 'from me elsewhere', 'Ryan Builder', 'user-ada'), // same account, bare spelling, the display name differs
      msg('m2', 'from my agent', 'Ryan Builder', MY_WALLET, { agentId: 'a1', agentName: 'Scout' }),
      msg('m3', 'from a namesake', 'Ada', 'SomeoneElse'), // same name as me, different account
    ],
  })
  await start($)
  await $.command.run({ command: 'hiveop', args: 'chat', ...RUN })
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    const rows = (await pane.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
    expect(rows).toMatch(/You\n\d\d:\d\d\nfrom me elsewhere/)
    expect(rows).not.toContain('Ryan Builder')
    expect(rows).toMatch(/Scout\n\d\d:\d\d\nfrom my agent/)
    expect(rows).toMatch(/Ada\n\d\d:\d\d\nfrom a namesake/)
    await pane.unmount()
  }
})

test('a run of messages shows the name and time once, the input is last, the header is branded', async ($, on) => {
  world(on, { history: [msg('m1', 'one', 'Bea', 'BeaWallet'), msg('m2', 'two', 'Bea', 'BeaWallet'), msg('m3', 'three', 'Bea', 'BeaWallet')] })
  await start($)
  await $.command.run({ command: 'hiveop', args: 'chat', ...RUN })
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    const rows = (await pane.findAll({ type: 'Text' })).map((t: any) => t.text)
    expect(rows.filter((t: string) => t === 'Bea')).toHaveLength(1)
    expect(rows.filter((t: string) => /^\d\d:\d\d$/.test(t))).toHaveLength(1)
    expect(rows).toEqual(expect.arrayContaining(['one', 'two', 'three', '⬡ HiveOp']))
    const all = await text(pane)
    expect(all.lastIndexOf('chat-input')).toBeGreaterThan(all.lastIndexOf('three'))
    expect(all.lastIndexOf('chat-input')).toBeGreaterThan(all.lastIndexOf('chat-close'))
    expect(await pane.find({ key: 'chat-close-ws-1' })).toBeDefined()
    await pane.unmount()
  }
})

test('band: plain hotkey buttons, the logo Image on the terminal and the glyph on desktop', async ($, on) => {
  world(on)
  await start($)
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    const shown = await text(band)
    expect(shown).toContain('"plain":true')
    for (const [key, hotkey] of [['band-chat', '1'], ['band-hide', '2']]) {
      expect(JSON.stringify(await band.find({ key }))).toContain(`"hotkey":"${hotkey}"`)
    }
    if (surface === 'terminal') {
      expect(shown).toContain('"type":"Image"')
      expect(shown).toContain('"columns":2')
      expect(shown).toContain('"rows":1')
    } else {
      expect(shown).not.toContain('Image')
      expect(shown).toContain('⬡')
    }
    await band.unmount()
  }
})

test('what you send shows as You', async ($, on) => {
  world(on)
  await start($)
  await $.command.run({ command: 'hiveop', args: 'chat', ...RUN })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.input({ key: 'chat-input', text: 'my line' })
  expect(await text(pane)).toMatch(/You[^]*my line/)
  await pane.unmount()
})
