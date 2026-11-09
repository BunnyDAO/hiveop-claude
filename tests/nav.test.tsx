import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/ada'
const KEY = 'wm_ct_SECRETKEYSECRETKEY'
const API = 'https://api.test/api/v1'
const ME = 'email:user-ada'
const BAND = { plugin: 'hiveop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const PANE = {
  plugin: 'hiveop',
  component: 'Pane',
  requestId: 'hiveop',
  props: { title: 'HiveOp', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const SURFACES = ['terminal', 'desktop'] as const

type Reply = { status: number; body?: unknown }
type World = {
  clock: ReturnType<typeof mock.clock>
  calls: { path: string; method: string; body: string; auth: string }[]
  logs: string[]
  store: Map<string, unknown>
  placed: boolean
  answers: string[] // scripted replies to $.ui.ask, in order
  asked: { question: string; options: string[] }[]
  forced: Map<string, Reply> // "METHOD /path" -> reply
  following: Set<string>
}

const MINE = [
  { id: 'w1', name: 'Forge' },
  { id: 'w2', name: 'Anvil' },
]
const PUBLIC = [
  { id: 'p1', name: 'OpenHub', kind: 'github', memberCount: 4, capabilities: { canJoin: true } },
  { id: 'p2', name: 'CloudNest', kind: 'cloud', memberCount: 2, capabilities: { canJoin: true } },
  { id: 'p3', name: 'ShutDoor', kind: 'cloud', memberCount: 1, capabilities: { canJoin: false } },
]
const PILOTS = [
  { wallet: 'BeaWallet', displayName: 'Bea', avatarUrl: null },
  { wallet: 'CyWallet', displayName: 'Cy', avatarUrl: null },
  { wallet: 'user-ada', displayName: 'Ada', avatarUrl: null }, // me
]
const INVITES = [{ invite: { id: 'i1', token: 'tok-1', workspaceId: 'w9' }, workspace: { id: 'w9', name: 'Skunkworks' } }]

function world(on: any, start: Partial<World> = {}): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 8, 12, 0) })
  const w: World = { clock, calls: [], logs: [], store: new Map(), placed: true, answers: [], asked: [], forced: new Map(), following: new Set(['CyWallet']), ...start }
  mock.env(on, { HOME, HIVEOP_API_URL: API })
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name ?? 'hiveop' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('fs.read', () => ({ value: JSON.stringify({ key: KEY }) }))
  on('store.get', (_: unknown, e: any) => ({ value: w.store.get(e.key) }))
  on('store.set', (_: unknown, e: any) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: w.placed ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  on('ui.panes', () => ({ value: w.placed ? [{ id: 'hiveop', title: 'HiveOp', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.render', () => ({ type: 'Text', children: ['engine'] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_: unknown, e: any) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: any) => {
    const q = e.questions[0]
    w.asked.push({ question: q.question, options: q.options.map((o: any) => o.label) })
    const a = w.answers.shift()
    if (a === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: a } } }
  })
  on('http.fetch', (_: unknown, e: any) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace(API, '')
    const body = e.init?.body ?? ''
    w.calls.push({ path, method, body, auth: e.init?.headers?.Authorization ?? '' })
    const reply = (r: Reply) => ({ value: { status: r.status, ok: r.status < 300, headers: {}, text: JSON.stringify(r.body ?? {}) } })
    const forced = w.forced.get(`${method} ${path}`)
    if (forced) return reply(forced)
    if (path.startsWith('/me/hive/profile')) return reply({ status: 200, body: { profile: { displayName: 'Ada', walletPubkey: ME } } })
    if (path === '/workspaces') return reply({ status: 200, body: { workspaces: MINE } })
    if (path.startsWith('/me/sync')) return reply({ status: 200, body: { cursor: 'c0', events: [], timedOut: true } })
    const chat = path.match(/^\/workspaces\/(\w+)\/chat/)
    if (chat && method === 'GET') {
      return reply({ status: 200, body: { messages: [{ id: `${chat[1]}-m1`, content: `hello from ${chat[1]}`, senderDisplayName: 'Bea', senderWallet: 'BeaWallet', createdAt: '2026-11-08T12:00:00Z' }] } })
    }
    if (path.startsWith('/workspaces/explore')) {
      const u = new URL(e.url)
      const search = u.searchParams.get('search') ?? ''
      const off = Number(u.searchParams.get('offset') ?? 0)
      const rows = PUBLIC.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
      return reply({ status: 200, body: { workspaces: rows.slice(off, off + Number(u.searchParams.get('limit') ?? 20)), total: rows.length } })
    }
    if (path === '/me/invites') return reply({ status: 200, body: { invites: INVITES } })
    if (path.startsWith('/pilots')) {
      const q = (new URL(e.url).searchParams.get('query') ?? '').toLowerCase()
      return reply({ status: 200, body: { pilots: PILOTS.filter((p) => p.displayName.toLowerCase().includes(q)) } })
    }
    if (path === '/me/following/among') {
      const wallets: string[] = JSON.parse(body).wallets
      return reply({ status: 200, body: { following: wallets.filter((x) => w.following.has(x)) } })
    }
    const fol = path.match(/^\/users\/(\w+)\/follow$/)
    if (fol) {
      if (method === 'POST') w.following.add(fol[1]!)
      else w.following.delete(fol[1]!)
      return reply({ status: 200, body: { success: true } })
    }
    if (/^\/workspaces\/\w+\/join$/.test(path) || /\/join-requests$/.test(path) || /\/redeem$/.test(path) || path === '/me/invites/decline') {
      return reply({ status: 200, body: { success: true, workspace: {} } })
    }
    return reply({ status: 404 })
  })
  return w
}

const start = async ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const text = async (ui: any) => JSON.stringify(await ui.drawn())
const rows = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
const mutations = (w: World) => w.calls.filter((c) => c.method !== 'GET')
const open = async ($: any, surface: string, args = '') => {
  await $.command.run({ command: 'hiveop', args, ...RUN })
  return $.ui.mount({ ...PANE, surface })
}

test('home: header with the name and every button, on both surfaces', async ($, on) => {
  world(on)
  await start($)
  for (const surface of SURFACES) {
    const pane = await open($, surface)
    expect(await text(pane)).toContain('HiveOp · Ada')
    for (const key of ['open-chat', 'home-work', 'home-claim', 'home-workspaces', 'home-people', 'sign-out']) {
      expect(await pane.find({ key })).toBeDefined()
    }
    const shown = await text(pane)
    expect(shown).toContain('Work here · soon')
    expect(shown).toContain('Claim next · soon')
    await pane.unmount()
  }
})

test('workspaces: mine marks the current one; picking one persists and the chat follows', async ($, on) => {
  const w = world(on)
  await start($)
  for (const surface of SURFACES) {
    const pane = await open($, surface)
    await pane.press({ key: 'home-workspaces' })
    if (surface === 'desktop') {
      expect(await text(pane)).toContain('● Anvil') // chosen in the terminal pass: one choice for the session
    } else {
      expect(await text(pane)).toContain('● Forge')
      const syncStarts = w.calls.filter((c) => c.path.startsWith('/me/sync?clientId=')).length
      await pane.press({ key: 'ws-use-w2' })
      expect(w.store.get('chat.workspace')).toEqual({ id: 'w2', name: 'Anvil' })
      expect(w.calls.some((c) => c.path.startsWith('/workspaces/w2/chat'))).toBe(true)
      expect(await text(pane)).toContain('● Anvil')
      // The sync loop is global: choosing a room does not restart it.
      expect(w.calls.filter((c) => c.path.startsWith('/me/sync?clientId=')).length).toBe(syncStarts)
      // Chat shows the new room.
      await pane.press({ key: 'nav-back' })
      await pane.press({ key: 'open-chat' })
      const room = await text(pane)
      expect(room).toContain('#Anvil')
      expect(room).toContain('hello from w2')
      expect(room).not.toContain('hello from w1')
    }
    await pane.unmount()
  }
})

test('the choice survives a new session', async ($, on) => {
  const w = world(on, { store: new Map([['chat.workspace', { id: 'w2', name: 'Anvil' }]]) })
  await start($)
  await w.clock.advance(10)
  const pane = await open($, 'terminal')
  await pane.press({ key: 'home-workspaces' })
  expect(await text(pane)).toContain('● Anvil')
  expect(w.calls.some((c) => c.path.startsWith('/workspaces/w2/chat'))).toBe(true)
  await pane.unmount()
})

test('invites: accept redeems with the token, decline sends the invite id', async ($, on) => {
  const w = world(on)
  await start($)
  const pane = await open($, 'terminal')
  await pane.press({ key: 'home-workspaces' })
  await pane.press({ key: 'tab-invites' })
  expect(await text(pane)).toContain('Skunkworks')
  await pane.press({ key: 'inv-accept-i1' })
  const m = mutations(w).filter((c) => c.method === 'POST')
  expect(m.at(-1)!.path).toBe('/workspaces/invites/tok-1/redeem')
  expect(await text(pane)).toContain('Joined Skunkworks.')
  await pane.unmount()
})

test('invites: decline', async ($, on) => {
  const w = world(on)
  await start($)
  const pane = await open($, 'desktop')
  await pane.press({ key: 'home-workspaces' })
  await pane.press({ key: 'tab-invites' })
  await pane.press({ key: 'inv-decline-i1' })
  const last = mutations(w).at(-1)!
  expect(last.path).toBe('/me/invites/decline')
  expect(JSON.parse(last.body)).toEqual({ inviteId: 'i1' })
  expect(await text(pane)).toContain('No invites.')
  await pane.unmount()
})

test('explore: search, paging, Join for open, Request to join for the rest, closed ones have no button', async ($, on) => {
  const w = world(on)
  await start($)
  const pane = await open($, 'terminal')
  await pane.press({ key: 'home-workspaces' })
  await pane.press({ key: 'tab-explore' })
  let shown = await text(pane)
  for (const n of ['OpenHub', 'CloudNest', 'ShutDoor']) expect(shown).toContain(n)
  expect(await pane.find({ key: 'ex-join-p1' })).toBeDefined()
  expect(shown).toContain('Request to join')
  expect(shown).toContain('closed')
  await pane.input({ key: 'ex-search', text: 'cloud' })
  shown = await text(pane)
  expect(shown).toContain('CloudNest')
  expect(shown).not.toContain('OpenHub')
  expect(w.calls.some((c) => c.path.includes('search=cloud'))).toBe(true)
  await pane.input({ key: 'ex-search', text: '' })
  await pane.press({ key: 'ex-join-p1' })
  expect(mutations(w).at(-1)!.path).toBe('/workspaces/p1/join')
  expect(await text(pane)).toContain('Joined OpenHub.')
  await pane.press({ key: 'ex-join-p2' })
  expect(mutations(w).at(-1)!.path).toBe('/workspaces/p2/join-requests')
  expect(await text(pane)).toContain('Asked to join CloudNest.')
  await pane.unmount()
})

test('a refusal is shown in the server\'s words', async ($, on) => {
  const w = world(on)
  w.forced.set('POST /workspaces/p1/join', { status: 402, body: { error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Joining a GitHub workspace needs a subscription.' } } })
  w.forced.set('POST /workspaces/p2/join-requests', { status: 409, body: { error: { message: 'You already have a pending request for this workspace' } } })
  await start($)
  const pane = await open($, 'terminal')
  await pane.press({ key: 'home-workspaces' })
  await pane.press({ key: 'tab-explore' })
  await pane.press({ key: 'ex-join-p1' })
  expect(await text(pane)).toContain('Joining a GitHub workspace needs a subscription.')
  await pane.press({ key: 'ex-join-p2' })
  expect(await text(pane)).toContain('You already have a pending request for this workspace')
  w.forced.set('POST /workspaces/p1/join', { status: 403, body: { error: { code: 'PAT_FORBIDDEN', message: 'Connect tokens cannot modify this resource.' } } })
  await pane.press({ key: 'ex-join-p1' })
  expect(await text(pane)).toContain('Connect tokens cannot modify this resource.')
  await pane.unmount()
})

test('people: search, follow state, follow and unfollow; not yourself', async ($, on) => {
  const w = world(on)
  await start($)
  for (const surface of SURFACES) {
    w.following = new Set(['CyWallet'])
    const pane = await open($, surface)
    await pane.press({ key: 'home-people' })
    const shown = await text(pane)
    expect(shown).toContain('Bea')
    expect(shown).toContain('Cy')
    expect(shown).not.toContain('Ada ') // me is not offered
    expect(await pane.find({ key: 'pp-follow-BeaWallet' })).toBeDefined()
    expect(await pane.find({ key: 'pp-unfollow-CyWallet' })).toBeDefined()
    await pane.press({ key: 'pp-follow-BeaWallet' })
    expect(mutations(w).at(-1)).toMatchObject({ path: '/users/BeaWallet/follow', method: 'POST' })
    expect(await pane.find({ key: 'pp-unfollow-BeaWallet' })).toBeDefined()
    await pane.press({ key: 'pp-unfollow-CyWallet' })
    expect(mutations(w).at(-1)).toMatchObject({ path: '/users/CyWallet/follow', method: 'DELETE' })
    await pane.input({ key: 'pp-search', text: 'be' })
    const found = await text(pane)
    expect(found).toContain('Bea')
    expect(found).not.toContain('Cy')
    expect(w.calls.some((c) => c.path.includes('query=be'))).toBe(true)
    await pane.unmount()
  }
})

test('every request carries the plugin key', async ($, on) => {
  const w = world(on)
  await start($)
  const pane = await open($, 'terminal')
  await pane.press({ key: 'home-people' })
  expect(w.calls.length).toBeGreaterThan(0)
  expect(w.calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true)
  await pane.unmount()
})

test('band: Hide removes it, home offers Show, and the choice is kept', async ($, on) => {
  const w = world(on)
  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-hide' })
  await band.unmount()
  expect(w.store.get('band.hidden')).toBe(true)
  const gone = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await gone.find({ key: 'band-chat' })).toBeUndefined()
  await gone.unmount()
  const pane = await open($, 'desktop')
  await pane.press({ key: 'home-show-band' })
  await pane.unmount()
  expect(w.store.get('band.hidden')).toBe(false)
  const back = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await back.find({ key: 'band-hide' })).toBeDefined()
  await back.unmount()
})

test('narrow: pick-lists give the same choices; command output stays neutral', async ($, on) => {
  const w = world(on, { placed: false, answers: ['Workspaces', 'Mine', 'Anvil'] })
  await start($)
  const out = await $.command.run({ command: 'hiveop', args: '', ...RUN })
  expect(w.asked[0]!.options).toEqual(['Chat', 'Workspaces', 'People', 'More'])
  expect(w.asked[1]!.options).toEqual(['Mine', 'Invites', 'Explore', 'Back'])
  expect(w.asked[2]!.options).toEqual(['Forge · current', 'Anvil', 'Back'])
  expect(JSON.stringify(out)).not.toMatch(/Forge|Anvil|Bea/)
  expect(w.store.get('chat.workspace')).toEqual({ id: 'w2', name: 'Anvil' })
  expect(w.logs.join('\n')).toContain('Now in Anvil.')
})

test('narrow: follow someone, join a workspace, accept an invite; names only in notices', async ($, on) => {
  const w = world(on, { placed: false, answers: ['People', 'Bea', 'Follow'] })
  await start($)
  let out = await $.command.run({ command: 'hiveop', args: '', ...RUN })
  expect(mutations(w).at(-1)).toMatchObject({ path: '/users/BeaWallet/follow', method: 'POST' })
  expect(w.logs.join('\n')).toContain('Following Bea.')
  expect(JSON.stringify(out)).not.toMatch(/Bea/)

  w.answers = ['Workspaces', 'Explore', 'OpenHub', 'Join']
  out = await $.command.run({ command: 'hiveop', args: '', ...RUN })
  expect(mutations(w).at(-1)!.path).toBe('/workspaces/p1/join')
  expect(JSON.stringify(out)).not.toMatch(/OpenHub/)

  w.answers = ['Workspaces', 'Invites', 'Skunkworks', 'Accept']
  out = await $.command.run({ command: 'hiveop', args: '', ...RUN })
  expect(mutations(w).at(-1)!.path).toBe('/workspaces/invites/tok-1/redeem')
  expect(JSON.stringify(out)).not.toMatch(/Skunkworks/)
})

test('narrow: typed text under Other searches', async ($, on) => {
  const w = world(on, { placed: false, answers: ['Workspaces', 'Explore', 'cloud', 'Back'] })
  await start($)
  await $.command.run({ command: 'hiveop', args: '', ...RUN })
  expect(w.calls.some((c) => c.path.includes('search=cloud'))).toBe(true)
})

test('narrow: hide and show the band from More', async ($, on) => {
  const w = world(on, { placed: false, answers: ['More', 'Hide band'] })
  await start($)
  await $.command.run({ command: 'hiveop', args: '', ...RUN })
  expect(w.store.get('band.hidden')).toBe(true)
  w.answers = ['More', 'Show band']
  await $.command.run({ command: 'hiveop', args: '', ...RUN })
  expect(w.store.get('band.hidden')).toBe(false)
})

for (const placed of [true, false]) {
  test(`no command output carries a name from a list (pane ${placed ? 'placed' : 'too narrow'})`, async ($, on) => {
    world(on, { placed })
    await start($)
    const outs = [
      await $.command.run({ command: 'hiveop', args: 'workspaces', ...RUN }),
      await $.command.run({ command: 'hiveop', args: 'people', ...RUN }),
      await $.command.run({ command: 'hiveop', args: '', ...RUN }),
    ]
    expect(JSON.stringify(outs)).not.toMatch(/Forge|Anvil|Bea|Cy|OpenHub|Skunkworks/)
  })
}
