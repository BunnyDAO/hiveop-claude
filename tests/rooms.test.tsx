import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/ada'
const KEY = 'wm_ct_SECRETKEYSECRETKEY'
const API = 'https://api.test/api/v1'
const ME = 'email:user-ada'
const BAND = { plugin: 'hiveop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const PANE = {
  plugin: 'hiveop',
  component: 'Pane',
  requestId: 'hiveop',
  props: { title: 'HiveOp', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const SURFACES = ['terminal', 'desktop'] as const
const NOTE = 'To code in it, open its folder and Join.'
const GAP = 3_500

type World = {
  clock: ReturnType<typeof mock.clock>
  store: Map<string, unknown>
  remote: string | null
  pending: unknown[]
  calls: string[]
  delivered: any[] // events the server has handed out: later history includes them
}

function world(on: any, start: Partial<World> = {}): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 9, 12, 0) })
  const w: World = { clock, store: new Map(), remote: null, pending: [], calls: [], delivered: [], ...start }
  mock.env(on, { HOME, HIVEOP_API_URL: API })
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name ?? 'hiveop' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', (_: unknown, e: any) => {
    const get = (e.argv ?? []).includes('get-url')
    if (get && w.remote === null) return { value: { exitCode: 2, stdout: '', stderr: '' } }
    return { value: { exitCode: 0, stdout: get ? `${w.remote}\n` : '', stderr: '' } }
  })
  on('fs.read', () => ({ value: JSON.stringify({ key: KEY }) }))
  on('store.get', (_: unknown, e: any) => ({ value: w.store.get(e.key) }))
  on('store.set', (_: unknown, e: any) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_: unknown, e: any) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'hiveop', title: 'HiveOp', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('http.fetch', (_: unknown, e: any) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace(API, '')
    w.calls.push(`${method} ${path}`)
    const reply = (status: number, body: unknown = {}) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
    if (path.startsWith('/me/hive/profile')) return reply(200, { profile: { displayName: 'Ada', walletPubkey: ME } })
    if (path.startsWith('/me/workspaces/match')) return reply(200, { success: true, mine: [{ id: 'w1', name: 'Forge' }], joinable: [] })
    if (path === '/workspaces') return reply(200, { workspaces: [{ id: 'w1', name: 'Forge' }, { id: 'w2', name: 'Anvil' }] })
    if (path.startsWith('/me/sync')) {
      if (!path.includes('cursor=')) return reply(200, { cursor: 'c0', events: [], timedOut: false })
      const events = w.pending
      w.delivered.push(...events)
      w.pending = []
      return reply(200, { cursor: 'c1', events, timedOut: events.length === 0 })
    }
    const chat = path.match(/^\/workspaces\/(\w+)\/chat/)
    if (chat && method === 'GET') {
      const later = w.delivered.filter((x: any) => x.workspaceId === chat[1]).map((x: any) => x.message)
      return reply(200, { messages: [...later, { id: `${chat[1]}-m1`, content: `hello from ${chat[1]}`, senderDisplayName: 'Bea', senderWallet: 'BeaWallet', createdAt: '2026-11-09T12:00:00Z' }] })
    }
    if (/\/adopted-sessions$/.test(path) && method === 'POST') return reply(200, { success: true, agentId: 'ag-1', name: 'Claude Code', color: '#d97757', resumed: false })
    if (/\/offline$/.test(path)) return reply(200, { success: true })
    if (path.endsWith('/work-summary')) return reply(200, { success: true, ready: 3, inProgress: 1, next: { id: 'i1', title: 'Fix it' } })
    return reply(404)
  })
  return w
}

const text = async (ui: any) => JSON.stringify(await ui.drawn())
const start = async ($: any) => $.session.start({ cwd: '/Users/ada/forge', surface: 'terminal', isInteractive: true })
const openList = async ($: any, surface: string) => {
  await $.command.run({ command: 'hiveop', args: 'workspaces', ...RUN })
  return $.ui.mount({ ...PANE, surface })
}
const chatMsg = (id: string, ws: string) => ({ type: 'workspace:chat_message', workspaceId: ws, message: { id, content: 'fresh', senderDisplayName: 'Bea', senderWallet: 'BeaWallet', createdAt: '2026-11-09T12:05:00Z' } })

for (const surface of SURFACES) {
  test(`tabs open, switch and close (${surface})`, async ($, on) => {
    const w = world(on)
    await start($)
    const pane = await openList($, surface)
    expect(await pane.find({ key: 'ws-use-w1' })).toBeUndefined()
    await pane.press({ key: 'ws-chat-w1' })
    await pane.press({ key: 'home-workspaces' }).catch(() => undefined)
    let shown = await text(pane)
    expect(shown).toContain('#Forge')
    expect(shown).toContain('hello from w1')
    // A second room is a second tab, and it is the one in view.
    await pane.press({ key: 'chat-back' })
    await pane.press({ key: 'home-workspaces' })
    await pane.press({ key: 'ws-chat-w2' })
    shown = await text(pane)
    expect(shown).toContain('hello from w2')
    expect(shown).not.toContain('hello from w1')
    expect(await pane.find({ key: 'chat-tab-w1' })).toBeDefined()
    expect(await pane.find({ key: 'chat-tab-w2' })).toBeDefined()
    expect(w.store.get('chat.tabs')).toEqual([{ id: 'w1', name: 'Forge' }, { id: 'w2', name: 'Anvil' }])
    // Switch back by the tab.
    await pane.press({ key: 'chat-tab-w1' })
    shown = await text(pane)
    expect(shown).toContain('hello from w1')
    expect(shown).not.toContain('hello from w2')
    // Close the viewed one: its neighbour takes over.
    await pane.press({ key: 'chat-close-w1' })
    shown = await text(pane)
    expect(shown).toContain('hello from w2')
    expect(await pane.find({ key: 'chat-tab-w1' })).toBeUndefined()
    expect(w.store.get('chat.tabs')).toEqual([{ id: 'w2', name: 'Anvil' }])
    // Close the last: nothing open.
    await pane.press({ key: 'chat-close-w2' })
    expect(w.store.get('chat.tabs')).toEqual([])
    await pane.unmount()
  })
}

test('a room out of view counts unread on its tab and on the band', async ($, on) => {
  const w = world(on, { store: new Map([['chat.tabs', [{ id: 'w1', name: 'Forge' }, { id: 'w2', name: 'Anvil' }]]]) })
  await start($)
  w.pending = [chatMsg('m7', 'w2'), chatMsg('m8', 'w2')]
  await w.clock.advance(GAP * 2)
  await $.command.run({ command: 'hiveop', args: 'chat', ...RUN })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await text(pane)).toContain('#Anvil 2')
  await pane.press({ key: 'chat-tab-w2' })
  expect(await text(pane)).toContain('── 2 new ──')
  await pane.unmount()
})

test('migration: the old current workspace becomes the first tab and its key is dropped', async ($, on) => {
  const w = world(on, { store: new Map([['chat.workspace', { id: 'w2', name: 'Anvil' }]]) })
  await start($)
  await w.clock.advance(50)
  expect(w.store.has('chat.workspace')).toBe(false)
  expect(w.store.get('chat.tabs')).toEqual([{ id: 'w2', name: 'Anvil' }])
  await $.command.run({ command: 'hiveop', args: 'chat', ...RUN })
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    const shown = await text(pane)
    expect(shown).toContain('chat-tab-w2')
    expect(shown).toContain('hello from w2')
    await pane.unmount()
  }
  // And it stays across a new session without the old key.
  await start($)
  await w.clock.advance(50)
  expect(w.store.get('chat.tabs')).toEqual([{ id: 'w2', name: 'Anvil' }])
})

test('no room is picked for you: no tabs, no chat requests, Chat leads to Workspaces', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  expect(w.calls.some((c) => /\/chat/.test(c))).toBe(false)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-chat' })
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ key: 'ws-chat-w1' })).toBeDefined()
  await pane.unmount()
})

for (const surface of SURFACES) {
  test(`band with a seat follows the seat's workspace (${surface})`, async ($, on) => {
    const w = world(on, { remote: 'git@github.com:acme/forge.git', store: new Map<string, unknown>([['join.auto', true], ['chat.tabs', [{ id: 'w2', name: 'Anvil' }]]]) })
    await start($)
    await w.clock.advance(50)
    const band = await $.ui.mount({ ...BAND, surface })
    const shown = await text(band)
    expect(shown).toContain('Forge')
    expect(shown).toContain('Claude Code')
    expect(shown).toContain('3 ready · 1 in progress · next: Fix it') // the seat's queue, not the viewed room's
    expect(w.calls).toContain('GET /workspaces/w1/work-summary')
    expect(w.calls).not.toContain('GET /workspaces/w2/work-summary')
    await band.unmount()
  })

  test(`band with no seat is social: unread and not-a-workspace-folder only (${surface})`, async ($, on) => {
    const w = world(on, { store: new Map([['chat.tabs', [{ id: 'w1', name: 'Forge' }, { id: 'w2', name: 'Anvil' }]]]) })
    await start($)
    w.pending = [chatMsg('m7', 'w2')]
    await w.clock.advance(GAP * 2)
    const band = await $.ui.mount({ ...BAND, surface })
    const shown = await text(band)
    expect(shown).toContain('1 new')
    expect(shown).toContain('Not a workspace folder')
    expect(shown).not.toContain('ready')
    expect(shown).not.toContain('band-claim')
    expect(w.calls.some((c) => c.endsWith('/work-summary'))).toBe(false)
    await band.unmount()
  })
}

for (const surface of SURFACES) {
  test(`the not-joined note shows for a room the session is not seated in (${surface})`, async ($, on) => {
    const w = world(on, { remote: 'git@github.com:acme/forge.git', store: new Map<string, unknown>([['join.auto', true], ['chat.tabs', [{ id: 'w1', name: 'Forge' }, { id: 'w2', name: 'Anvil' }]]]) })
    await start($)
    await w.clock.advance(50)
    await $.command.run({ command: 'hiveop', args: 'chat', ...RUN })
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await text(pane)).not.toContain(NOTE) // w1 is the seat
    await pane.press({ key: 'chat-tab-w2' })
    expect(await text(pane)).toContain(NOTE)
    await pane.unmount()
  })
}

test('the not-joined note and chat words stay out of command output', async ($, on) => {
  world(on, { store: new Map([['chat.tabs', [{ id: 'w1', name: 'Forge' }]]]) })
  await start($)
  const outs = [await $.command.run({ command: 'hiveop', args: 'chat', ...RUN }), await $.command.run({ command: 'say', args: 'hi', ...RUN })]
  expect(JSON.stringify(outs)).not.toMatch(/hello from|To code in it|Forge/)
})

test('no global current workspace: no Use button, no current marker, no old key', async ($, on) => {
  const w = world(on, { store: new Map([['chat.workspace', { id: 'w1', name: 'Forge' }]]) })
  await start($)
  await w.clock.advance(50)
  const pane = await openList($, 'terminal')
  const shown = await text(pane)
  expect(shown).not.toContain('ws-use-')
  expect(shown).not.toContain('current')
  expect(shown).not.toContain('● ')
  expect(w.store.has('chat.workspace')).toBe(false)
  await pane.unmount()
})
