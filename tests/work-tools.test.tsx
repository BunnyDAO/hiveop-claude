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
  posts: { path: string; body: any; agent?: string }[]
  gets: { path: string; agent?: string }[]
  finish: { status: number; body: any }
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
    gets: [],
    finish: { status: 200, body: { success: true, verdict: { outcome: 'pass' }, drain: { drained: true, submittedIssueId: 'i1', nextIssueId: 'i2' } } },
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
    const agent = e.init?.headers?.['X-HiveOp-Agent']
    if (method === 'POST') w.posts.push({ path, body: e.init?.body ? JSON.parse(e.init.body) : null, agent })
    else w.gets.push({ path, agent })
    if (path.endsWith('/issues/ready')) return reply(200, { success: true, issues: [{ id: 'i1', title: 'Fix login', description: 'The login button is broken', priority: 'high' }, { id: 'i2', title: 'Add tests', description: '' }] })
    if (/\/issues\/i[0-9]$/.test(path)) return reply(200, { success: true, issue: { id: path.split('/').pop(), title: path.endsWith('i2') ? 'Add tests' : 'Fix login', description: 'Details' } })
    if (/\/issues\/[^/]+\/claim$/.test(path)) return reply(200, { success: true, issue: { id: path.split('/')[4], title: 'Fix login' } })
    if (path.endsWith('/verification/run')) return reply(w.finish.status, w.finish.body)
    if (path.startsWith('/me/hive/profile')) return reply(200, { profile: { displayName: 'Ada', walletPubkey: ME } })
    if (path.startsWith('/me/workspaces/match')) {
      w.matchQueries.push(decodeURIComponent(path.split('remote=')[1] ?? ''))
      return reply(200, { success: true, ...w.match })
    }
    if (path === '/workspaces') return reply(200, { workspaces: [{ id: WS, name: 'Forge' }, { id: 'ws-2', name: 'Other' }] })
    if (path.startsWith('/me/sync')) return reply(200, { cursor: 'c0', events: [], timedOut: true })
    if (path.startsWith('/workspaces/') && path.endsWith('/chat?limit=40')) return reply(200, { messages: [] })
    if (path.includes('/chat')) return reply(200, { messages: [{ id: 'm1', text: 'SECRET PLAN from Bea', authorName: 'Bea', createdAt: new Date().toISOString() }] })
    if (path.endsWith('/work-summary')) return reply(200, { success: true, ready: 1, inProgress: 0, next: { id: 'i1', title: 'Fix login' } })
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

const tool = async ($: any, name: string, input: Record<string, unknown> = {}) =>
  JSON.stringify(await $.tool.call({ tool: `mcp__hiveop__${name}`, ...input } as any))
const join = async ($: any, w: World) => {
  await start($)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-join' })
  await band.unmount()
}

test('hcp-17: the work tools are registered and say "not joined" outside a seat', async ($, on) => {
  const w = world(on)
  const registered: string[] = []
  on('tool.register', (_: unknown, e: any) => {
    registered.push(e.name)
    return { value: { tool: `mcp__hiveop__${e.name}` } }
  })
  await start($)
  await w.clock.advance(50)
  expect(registered.sort()).toEqual(['claim_work', 'finish_work', 'next_work'])
  expect(await tool($, 'next_work')).toContain('Not joined')
  expect(w.gets.filter((g) => g.path.includes('/issues'))).toHaveLength(0)
})

test('hcp-17: next_work lists ready items of the joined workspace only, as the agent', async ($, on) => {
  const w = world(on)
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__hiveop__${e.name}` } }))
  await join($, w)
  const out = await tool($, 'next_work')
  expect(out).toContain('Fix login')
  expect(out).toContain('i1')
  const g = w.gets.find((x) => x.path.endsWith('/issues/ready'))!
  expect(g.path).toBe(`/workspaces/${WS}/issues/ready`)
  expect(g.agent).toBe('ag-1')
  expect(out).not.toContain('SECRET PLAN')
})

test('hcp-17: claim_work claims as the agent (top ready by default), and the seat remembers it', async ($, on) => {
  const w = world(on)
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__hiveop__${e.name}` } }))
  await join($, w)
  const out = await tool($, 'claim_work')
  const claim = w.posts.find((p) => p.path.endsWith('/claim'))!
  expect(claim.path).toBe(`/workspaces/${WS}/issues/i1/claim`)
  expect(claim.agent).toBe('ag-1')
  expect(out).toContain('Fix login')
  expect(out).toContain('Details')
  expect(await compose($)).toContain('Claimed item: Fix login')
  await tool($, 'claim_work', { issueId: 'i2' })
  expect(w.posts.filter((p) => p.path.endsWith('/claim')).pop()!.path).toBe(`/workspaces/${WS}/issues/i2/claim`)
})

test('hcp-17: a workspace id in the input is ignored: tools stay pinned to the seat', async ($, on) => {
  const w = world(on)
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__hiveop__${e.name}` } }))
  await join($, w)
  await tool($, 'claim_work', { workspaceId: 'ws-2', issueId: 'i1' })
  expect(w.posts.filter((p) => p.path.includes('ws-2'))).toHaveLength(0)
})

test('hcp-17: finish_work verifies as the agent and names the next item', async ($, on) => {
  const w = world(on)
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__hiveop__${e.name}` } }))
  await join($, w)
  const out = await tool($, 'finish_work')
  const fin = w.posts.find((p) => p.path.endsWith('/verification/run'))!
  expect(fin.path).toBe(`/workspaces/${WS}/verification/run`)
  expect(fin.agent).toBe('ag-1')
  expect(out).toMatch(/passed/i)
  expect(out).toContain('Add tests')
  w.finish = { status: 200, body: { success: true, verdict: { outcome: 'could_not_start', detail: 'no linked PR' }, policy: { action: 'retry' }, drain: { drained: false } } }
  const out2 = await tool($, 'finish_work')
  expect(out2).toContain('no linked PR')
})

test('hcp-17: the band Claim credits the agent while joined', async ($, on) => {
  const w = world(on)
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__hiveop__${e.name}` } }))
  await join($, w)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'band-claim' })
  await band.unmount()
  const claim = w.posts.find((p) => p.path.endsWith('/claim'))!
  expect(claim.path).toBe(`/workspaces/${WS}/issues/i1/claim`)
  expect(claim.agent).toBe('ag-1')
})
