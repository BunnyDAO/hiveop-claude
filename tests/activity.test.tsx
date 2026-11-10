import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/ada'
const KEY = 'wm_ct_SECRETKEYSECRETKEY'
const API = 'https://api.test/api/v1'
const WS = 'ws-1'
const ME = 'email:user-ada'
const CWD = '/Users/ada/Projects/ThisOrThat'
const BAND = { plugin: 'hiveop', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
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
  for (const tool of ['Edit', 'Read', 'Write', 'Bash', 'Grep']) on('tool.call', { tool }, () => ({ result: 'done' }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
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
    if (/\/adopted-sessions\/[^/]+\/activity$/.test(path) && method === 'POST') return reply(200, { success: true })
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

const acts = (w: World) => w.posts.filter((p) => /\/activity$/.test(p.path))
const join = async ($: any, w: World) => {
  await start($)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-join' })
  await band.unmount()
}

test('hcp-16: seated, a turn reports start, the files it touches (relative), and stop', async ($, on) => {
  const w = world(on)
  await join($, w)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/app.ts`, old_string: 'a', new_string: 'b' } as any)
  await w.clock.advance(10)
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  await w.clock.advance(10)
  const sent = acts(w)
  expect(sent.map((p) => p.body.kind)).toEqual(['start', 'tool', 'stop'])
  expect(sent[0]!.path).toBe(`/workspaces/${WS}/adopted-sessions/ag-1/activity`)
  expect(sent[1]!.body.filePaths).toEqual(['src/app.ts'])
  expect(sent[1]!.body.thinking).toBe('Editing app.ts')
  expect(JSON.stringify(sent)).not.toContain('/Users')
})

test('hcp-16: files outside the folder and Bash commands are never sent', async ($, on) => {
  const w = world(on)
  await join($, w)
  await $.tool.call({ tool: 'Read', file_path: '/etc/hosts' } as any)
  await w.clock.advance(3000)
  await $.tool.call({ tool: 'Bash', command: 'curl -H "Authorization: secret" x' } as any)
  await w.clock.advance(3000)
  const sent = acts(w)
  expect(sent.every((p) => !p.body.filePaths || p.body.filePaths.length === 0)).toBe(true)
  expect(JSON.stringify(sent)).not.toContain('secret')
  expect(JSON.stringify(sent)).not.toContain('/etc')
})

test('hcp-16: a busy turn is batched to one tool report per 2s, keeping the files', async ($, on) => {
  const w = world(on)
  await join($, w)
  for (let i = 0; i < 6; i++) await $.tool.call({ tool: 'Read', file_path: `${CWD}/f${i}.ts` } as any)
  expect(acts(w).filter((p) => p.body.kind === 'tool')).toHaveLength(1)
  await w.clock.advance(2100)
  const tools = acts(w).filter((p) => p.body.kind === 'tool')
  expect(tools).toHaveLength(2)
  expect(tools[1]!.body.filePaths).toEqual(['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts'])
})

test('hcp-16: not seated, or after Leave, nothing is reported', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' } as any)
  expect(acts(w)).toHaveLength(0)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-join' })
  await band.press({ key: 'band-leave' })
  await band.unmount()
  await $.turn.start({ text: 'x', turnId: 't2' })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' } as any)
  await w.clock.advance(3000)
  expect(acts(w)).toHaveLength(0)
})

test('hcp-16: a subagent turn does not start or stop the session', async ($, on) => {
  const w = world(on)
  await join($, w)
  await $.turn.start({ text: 'sub', turnId: 't3', agentId: 'sub-1' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't3', agentId: 'sub-1', reason: 'answer' } as any)
  expect(acts(w)).toHaveLength(0)
})
