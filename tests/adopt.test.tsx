import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/ada'
const KEY = 'wm_ct_SECRETKEYSECRETKEY'
const API = 'https://api.test/api/v1'
const WS = 'ws-1'
const ME = 'email:user-ada'
const CWD = '/Users/ada/Projects/ThisOrThat'
const BAND = { plugin: 'hiveop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const PANE = {
  plugin: 'hiveop',
  component: 'Pane',
  requestId: 'hiveop',
  props: { title: 'HiveOp', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const

type Match = { mine: { id: string; name: string }[]; joinable: { id: string; name: string }[] }
type World = {
  clock: ReturnType<typeof mock.clock>
  posts: { path: string; body: any }[]
  matchQueries: string[]
  remote: string | null
  match: Match
  adoptStatus: number
  answers: string[]
  store: Map<string, unknown>
  agent: { agentId: string; name: string; color: string; resumed: boolean }
}

function world(on: any, start: Partial<World> = {}): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 9, 12, 0) })
  const w: World = {
    clock,
    posts: [],
    matchQueries: [],
    remote: 'git@github.com:acme/this-or-that.git',
    match: { mine: [{ id: WS, name: 'Forge' }], joinable: [] },
    adoptStatus: 200,
    answers: [],
    store: new Map(),
    agent: { agentId: 'ag-1', name: 'Claude Code', color: '#d97757', resumed: false },
    ...start,
  }
  mock.env(on, { HOME, HIVEOP_API_URL: API })
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name ?? 'hiveop' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-123' }))
  on('session.end', (_: unknown, e: any) => ({ sessionId: e.sessionId }))
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv ?? []
    if (argv.includes('get-url')) {
      return w.remote === null ? { value: { exitCode: 2, stdout: '', stderr: 'no remote' } } : { value: { exitCode: 0, stdout: w.remote + '\n', stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('fs.read', () => ({ value: JSON.stringify({ key: KEY }) }))
  on('store.get', (_: unknown, e: any) => ({ value: w.store.get(e.key) }))
  on('store.set', (_: unknown, e: any) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'hiveop', title: 'HiveOp', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: any) => {
    const q = e.questions[0]
    const a = w.answers.shift()
    if (a === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: a } } }
  })
  on('http.fetch', (_: unknown, e: any) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace(API, '')
    const reply = (status: number, body: unknown = {}) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
    if (method === 'POST') w.posts.push({ path, body: e.init?.body ? JSON.parse(e.init.body) : null })
    if (path.startsWith('/me/hive/profile')) return reply(200, { profile: { displayName: 'Ada', walletPubkey: ME } })
    if (path.startsWith('/me/workspaces/match')) {
      w.matchQueries.push(decodeURIComponent(path.split('remote=')[1] ?? ''))
      return reply(200, { success: true, ...w.match })
    }
    if (path === '/workspaces') return reply(200, { workspaces: [{ id: WS, name: 'Forge' }, { id: 'ws-2', name: 'Other' }] })
    if (path.startsWith('/me/sync')) return reply(200, { cursor: 'c0', events: [], timedOut: true })
    if (path.startsWith('/workspaces/') && path.endsWith('/chat?limit=40')) return reply(200, { messages: [] })
    if (path.includes('/chat')) return reply(200, { messages: [{ id: 'm1', text: 'SECRET PLAN from Bea', authorName: 'Bea', createdAt: new Date().toISOString() }] })
    if (path.endsWith('/work-summary')) return reply(200, { success: true, ready: 0, inProgress: 0, next: null })
    if (/\/adopted-sessions$/.test(path) && method === 'POST') return reply(w.adoptStatus, w.adoptStatus < 300 ? { success: true, ...w.agent } : { success: false, error: { message: 'Requires member role or higher' } })
    if (/\/adopted-sessions\/[^/]+\/offline$/.test(path) && method === 'POST') return reply(200, { success: true })
    if (path.endsWith('/join-requests') && method === 'POST') return reply(200, { success: true })
    return reply(404)
  })
  return w
}

const text = async (ui: any) => JSON.stringify(await ui.drawn())
const start = async ($: any, cwd = CWD) => $.session.start({ cwd, surface: 'terminal', isInteractive: true })
const adopts = (w: World) => w.posts.filter((p) => /\/adopted-sessions$/.test(p.path))
const offlines = (w: World) => w.posts.filter((p) => /\/offline$/.test(p.path))
const compose = async ($: any) =>
  JSON.stringify(await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] }))

test('a folder whose remote matches a workspace offers Join as agent; nothing is joined yet', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  expect(w.matchQueries).toEqual(['git@github.com:acme/this-or-that.git'])
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    const shown = await text(band)
    expect(shown).toContain('Forge')
    expect(await band.find({ key: 'band-join' })).toBeDefined()
    await band.unmount()
  }
  expect(adopts(w)).toHaveLength(0)
  expect(await compose($)).not.toContain('hiveop:seat')
})

test('Join registers the session (opaque keys, no path) and the band shows the agent', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-join' })
  expect(adopts(w)).toHaveLength(1)
  expect(adopts(w)[0]!.path).toBe(`/workspaces/${WS}/adopted-sessions`)
  const body = adopts(w)[0]!.body
  expect(body.sessionKey).toBe('sess-123')
  expect(body.folderKey).toMatch(/^[a-f0-9]{8,64}$/)
  expect(JSON.stringify(body)).not.toContain('ThisOrThat')
  expect(JSON.stringify(body)).not.toContain('/Users')
  const shown = await text(band)
  expect(shown).toContain('Forge')
  expect(shown).toContain('Claude Code')
  expect(shown).not.toContain('band-join')
  expect(await band.find({ key: 'band-leave' })).toBeDefined()
  await band.unmount()
})

test('the system prompt carries only the seat: workspace, agent, nothing from chat', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-join' })
  await w.clock.advance(5_000) // chat sync has had its turn
  const prompt = await compose($)
  expect(prompt).toContain('hiveop:seat')
  expect(prompt).toContain('Forge')
  expect(prompt).toContain(WS)
  expect(prompt).toContain('Claude Code')
  expect(prompt).not.toContain('SECRET PLAN')
  expect(prompt).not.toContain('Bea')
  expect(prompt).not.toContain(KEY)
  await band.unmount()
})

test('Leave goes offline, drops the seat, and the band offers Join again', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-join' })
  await band.press({ key: 'band-leave' })
  expect(offlines(w)).toHaveLength(1)
  expect(offlines(w)[0]!.path).toBe(`/workspaces/${WS}/adopted-sessions/ag-1/offline`)
  expect(await compose($)).not.toContain('hiveop:seat')
  expect(await band.find({ key: 'band-join' })).toBeDefined()
  await band.unmount()
})

test('session end takes the agent offline', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-join' })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-123', resume: { id: 'sess-123' } })
  expect(offlines(w)).toHaveLength(1)
  await band.unmount()
})

test('no matching workspace: social mode, no Join, nothing registered', async ($, on) => {
  const w = world(on, { match: { mine: [], joinable: [] } })
  await start($)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const shown = await text(band)
  expect(shown).not.toContain('band-join')
  expect(shown).not.toContain('band-request')
  expect(adopts(w)).toHaveLength(0)
  await band.unmount()
})

test('no git remote: no lookup at all', async ($, on) => {
  const w = world(on, { remote: null })
  await start($)
  await w.clock.advance(50)
  expect(w.matchQueries).toHaveLength(0)
})

test('a repo that belongs to a workspace you are not in offers Request to join', async ($, on) => {
  const w = world(on, { match: { mine: [], joinable: [{ id: 'ws-9', name: 'Theirs' }] } })
  await start($)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await text(band)).toContain('Theirs')
  await band.press({ key: 'band-request' })
  expect(w.posts.some((p) => p.path === '/workspaces/ws-9/join-requests')).toBe(true)
  expect(adopts(w)).toHaveLength(0)
  await band.unmount()
})

test('Join automatically: the home toggle is kept and the next session joins by itself', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(adopts(w)).toHaveLength(0)
  await pane.press({ key: 'home-auto' })
  expect(w.store.get('join.auto')).toBe(true)
  expect(adopts(w)).toHaveLength(1) // turning it on joins this folder now
  await pane.unmount()
  await $.session.end({ reason: 'other', sessionId: 'sess-123', resume: { id: 'sess-123' } })
  expect(offlines(w)).toHaveLength(1)
  await start($)
  await w.clock.advance(50)
  expect(adopts(w)).toHaveLength(2) // the next session joins by itself, nobody pressed anything
})

test('a refusal (not a member) is said in the server\'s words and no seat is taken', async ($, on) => {
  const w = world(on, { adoptStatus: 403 })
  await start($)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-join' })
  expect(await text(band)).toContain('Requires member role')
  expect(await compose($)).not.toContain('hiveop:seat')
  await band.unmount()
})

test('home Work here with no matching folder joins nothing (the folder decides the workspace)', async ($, on) => {
  const w = world(on, { match: { mine: [], joinable: [] }, answers: ['Forge'] })
  await start($)
  await w.clock.advance(50)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'home-work' })
  expect(adopts(w)).toHaveLength(0)
  await pane.unmount()
})

test('a claim while seated is part of the seat facts', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-join' })
  expect(await compose($)).not.toContain('Claimed item')
  await band.unmount()
})
