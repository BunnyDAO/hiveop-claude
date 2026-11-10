import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/ada'
const KEY = 'wm_ct_SECRETKEYSECRETKEY'
const API = 'https://api.test/api/v1'
const ME = 'email:user-ada'
const PANE = {
  plugin: 'hiveop',
  component: 'Pane',
  requestId: 'hiveop',
  props: { title: 'HiveOp', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const
const WSROWS = [
  { id: 'w-press', name: 'Press Room', kind: 'github', githubRepoUrl: 'https://github.com/acme/press' },
  { id: 'w-cloud', name: 'Cloudy', kind: 'cloud', githubRepoUrl: '' },
  { id: 'w-local', name: 'Laptop', kind: 'local', githubRepoUrl: '' },
]
const APPROVAL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'
const URL_ = `https://app.hiveop.io/claude-code/approve?id=${APPROVAL_ID}`

type Agent = { id: string; name: string; color: string; state: string; creditsPerHour: number; lastActivityAt: string }
type World = {
  calls: { method: string; path: string; body: any }[]
  opens: string[][]
  state: { approval: 'pending' | 'approved' | 'denied' | 'expired'; agents: Agent[]; reject: number | null; openFails: boolean }
  clock: ReturnType<typeof mock.clock>
}
const AGENT: Agent = { id: 'agent-1', name: 'Claude', color: '#22d3ee', state: 'awake', creditsPerHour: 48, lastActivityAt: '2026-11-09T12:00:00.000Z' }

function world(on: any, state: Partial<World['state']> = {}): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 9, 12, 0) })
  const w: World = { calls: [], opens: [], state: { approval: 'pending', agents: [], reject: null, openFails: false, ...state }, clock }
  mock.env(on, { HOME, HIVEOP_API_URL: API, TERM_PROGRAM: 'Apple_Terminal' })
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name ?? 'hiveop' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-123' }))
  on('session.end', (_: unknown, e: any) => ({ sessionId: e.sessionId }))
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv ?? []
    if (argv[0] === 'open') {
      w.opens.push(argv)
      if (w.state.openFails) throw new Error('no open')
    }
    return { value: { exitCode: argv[0] === 'git' ? 128 : 0, stdout: '', stderr: '' } }
  })
  on('fs.list', () => {
    throw new Error('ENOENT')
  })
  on('fs.read', () => ({ value: JSON.stringify({ key: KEY }) }))
  const store = new Map<string, unknown>()
  on('store.get', (_: unknown, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'hiveop', title: 'HiveOp', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('http.fetch', (_: unknown, e: any) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace(API, '')
    const body = e.init?.body ? JSON.parse(e.init.body) : null
    const reply = (status: number, b: unknown = {}) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(b) } })
    if (path.startsWith('/me/hive/profile')) return reply(200, { profile: { displayName: 'Ada', walletPubkey: ME } })
    if (path.startsWith('/me/workspaces/match')) return reply(200, { success: true, mine: [], joinable: [] })
    if (path === '/workspaces') return reply(200, { workspaces: WSROWS })
    if (path.startsWith('/me/sync')) return reply(200, { cursor: 'c0', events: [], timedOut: true })
    if (path.endsWith('/work-summary')) return reply(200, { success: true, ready: 0, inProgress: 0, next: null })
    w.calls.push({ method, path, body })
    if (path === '/me/plugin-approvals' && method === 'POST') {
      if (w.state.reject) return reply(w.state.reject, { error: { message: 'No access to this workspace.' } })
      return reply(201, { success: true, approval: { id: APPROVAL_ID, kind: 'cloud_run', state: 'pending', workspaceId: body.workspaceId, agentId: body.agentId ?? null, expiresAt: new Date(Date.UTC(2026, 10, 9, 12, 10)).toISOString(), result: null } })
    }
    if (path === `/me/plugin-approvals/${APPROVAL_ID}`) {
      const st = w.state.approval
      return reply(200, { success: true, approval: { id: APPROVAL_ID, state: st, result: st === 'approved' ? { agentId: 'agent-1', workspaceId: 'w-cloud' } : null } })
    }
    const m = path.match(/^\/workspaces\/([^/]+)\/cloud-agents$/)
    if (m) return reply(200, { success: true, agents: m[1] === 'w-cloud' ? w.state.agents : [] })
    if (/^\/me\/cloud-agents\/[^/]+\/sleep$/.test(path) && method === 'POST') {
      w.state.agents = w.state.agents.map((a) => ({ ...a, state: 'asleep' }))
      return reply(200, { success: true })
    }
    return reply(404)
  })
  return w
}

const text = async (ui: any) => JSON.stringify(await ui.drawn())
const start = async ($: any) => $.session.start({ cwd: '/tmp/x', surface: 'terminal', isInteractive: true })
async function workspaces($: any, surface: 'terminal' | 'desktop', row = 'w-cloud') {
  const pane = await $.ui.mount({ ...PANE, surface })
  if (await pane.find({ key: 'home-workspaces' })) await pane.press({ key: 'home-workspaces' })
  await openRow(pane, row)
  return pane
}
/** A row's actions and cloud agents sit behind More; open `row` if it is not already. */
async function openRow(pane: any, row: string) {
  if (!(await pane.find({ key: `ws-chat-${row}` }))) await pane.press({ key: `ws-more-${row}` })
}
async function ready(w: World, $: any) {
  await start($)
  await w.clock.advance(50)
}
const posts = (w: World) => w.calls.filter((c) => c.method === 'POST' && c.path === '/me/plugin-approvals')
const agentFetches = (w: World) => w.calls.filter((c) => c.path.endsWith('/cloud-agents')).length

test('rows are one line; More shows Run in cloud and who pays, once; local rows have no Run in cloud', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    if (await pane.find({ key: 'home-workspaces' })) await pane.press({ key: 'home-workspaces' })
    if (await pane.find({ key: 'ws-chat-w-cloud' })) await pane.press({ key: 'ws-more-w-cloud' })
    expect(await pane.find({ key: 'ws-cloud-w-cloud' })).toBeUndefined()
    expect(await text(pane)).not.toContain('your Claude plan')
    for (const row of ['w-press', 'w-cloud']) {
      await openRow(pane, row)
      expect(await pane.find({ key: `ws-cloud-${row}` })).toBeDefined()
      expect((await text(pane)).match(/your Claude plan/gi)?.length).toBe(1)
      expect(await text(pane)).toContain('HiveOp credits')
    }
    await openRow(pane, 'w-local')
    expect(await pane.find({ key: 'ws-cloud-w-local' })).toBeUndefined()
    await pane.press({ key: 'ws-more-w-local' })
    await pane.unmount()
  }
})

test('request, pending, approved, then the agent line shows', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  for (const surface of SURFACES) {
    w.calls.length = 0
    w.opens.length = 0
    w.state.approval = 'pending'
    w.state.agents = []
    const pane = await workspaces($, surface)
    await pane.press({ key: 'ws-cloud-w-cloud' })
    await w.clock.advance(50)
    expect(posts(w)).toHaveLength(1)
    expect(posts(w)[0]!.body).toEqual({ kind: 'cloud_run', workspaceId: 'w-cloud' })
    expect(w.opens).toEqual([['open', URL_]])
    const shown = await text(pane)
    expect(shown).toContain('Approve in your browser…')
    expect(shown).toContain(URL_)
    // still pending after a poll
    await w.clock.advance(2000)
    expect(await text(pane)).toContain('Approve in your browser…')
    w.state.approval = 'approved'
    w.state.agents = [AGENT]
    await w.clock.advance(2000)
    const after = await text(pane)
    expect(after).not.toContain('Approve in your browser…')
    expect(after).toContain('Claude')
    expect(after).toContain('awake')
    expect(after).toContain('Cloud: awake · 48 cr/hr')
    expect(after).not.toContain('when awake')
    expect(await pane.find({ key: 'cloud-sleep-agent-1' })).toBeDefined()
    expect(await pane.find({ key: 'cloud-term-agent-1' })).toBeDefined()
    expect(await pane.find({ key: 'cloud-wake-agent-1' })).toBeUndefined()
    await pane.unmount()
  }
})

test('polling is about every 2 seconds and stops once decided', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-cloud-w-cloud' })
  await w.clock.advance(50)
  const polls = () => w.calls.filter((c) => c.path === `/me/plugin-approvals/${APPROVAL_ID}`).length
  await w.clock.advance(6000)
  expect(polls()).toBeGreaterThanOrEqual(2)
  expect(polls()).toBeLessThanOrEqual(4)
  w.state.approval = 'denied'
  await w.clock.advance(2000)
  const n = polls()
  await w.clock.advance(10_000)
  expect(polls()).toBe(n)
  await pane.unmount()
})

test('denied says Not approved. and no agent line', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  for (const surface of SURFACES) {
    w.state.approval = 'pending'
    const pane = await workspaces($, surface)
    await pane.press({ key: 'ws-cloud-w-cloud' })
    await w.clock.advance(50)
    w.state.approval = 'denied'
    await w.clock.advance(2000)
    const shown = await text(pane)
    expect(shown).toContain('Not approved.')
    expect(shown).not.toContain('Approve in your browser…')
    expect(await pane.find({ key: 'cloud-sleep-agent-1' })).toBeUndefined()
    await pane.unmount()
  }
})

test('expired says Request expired.', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  for (const surface of SURFACES) {
    w.state.approval = 'pending'
    const pane = await workspaces($, surface)
    await pane.press({ key: 'ws-cloud-w-cloud' })
    await w.clock.advance(50)
    w.state.approval = 'expired'
    await w.clock.advance(2000)
    expect(await text(pane)).toContain('Request expired.')
    await pane.unmount()
  }
})

test('a request that runs past its expiry stops polling and says expired', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-cloud-w-cloud' })
  await w.clock.advance(11 * 60_000)
  expect(await text(pane)).toContain('Request expired.')
  await pane.unmount()
})

test('a refused request shows the server words and opens nothing', async ($, on) => {
  const w = world(on, { reject: 403 })
  await ready(w, $)
  const pane = await workspaces($, 'desktop')
  await pane.press({ key: 'ws-cloud-w-cloud' })
  await w.clock.advance(50)
  expect(await text(pane)).toContain('No access to this workspace.')
  expect(w.opens).toHaveLength(0)
  await pane.unmount()
})

test('if the browser will not open, the URL is still shown', async ($, on) => {
  const w = world(on, { openFails: true })
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-cloud-w-cloud' })
  await w.clock.advance(50)
  expect(await text(pane)).toContain(URL_)
  await pane.unmount()
})

test('Sleep calls the API with the key and the line turns asleep', async ($, on) => {
  const w = world(on, { agents: [AGENT] })
  await ready(w, $)
  for (const surface of SURFACES) {
    w.state.agents = [AGENT]
    w.calls.length = 0
    await w.clock.advance(31_000) // the slow refresh picks the awake agent up again
    const pane = await workspaces($, surface)
    await w.clock.advance(50)
    await pane.press({ key: 'cloud-sleep-agent-1' })
    await w.clock.advance(50)
    expect(w.calls.some((c) => c.method === 'POST' && c.path === '/me/cloud-agents/agent-1/sleep')).toBe(true)
    expect(await text(pane)).toContain('asleep')
    expect(await text(pane)).toContain('Cloud: asleep · 48 cr/hr when awake')
    expect(await pane.find({ key: 'cloud-wake-agent-1' })).toBeDefined()
    expect(await pane.find({ key: 'cloud-sleep-agent-1' })).toBeUndefined()
    await pane.unmount()
  }
})

test('Wake files an approval with the agent id and opens the browser; it does not wake by itself', async ($, on) => {
  const w = world(on, { agents: [{ ...AGENT, state: 'asleep' }] })
  await ready(w, $)
  for (const surface of SURFACES) {
    w.calls.length = 0
    w.opens.length = 0
    w.state.approval = 'pending'
    const pane = await workspaces($, surface)
    await w.clock.advance(50)
    await pane.press({ key: 'cloud-wake-agent-1' })
    await w.clock.advance(50)
    expect(posts(w)).toHaveLength(1)
    expect(posts(w)[0]!.body).toEqual({ kind: 'cloud_run', workspaceId: 'w-cloud', agentId: 'agent-1' })
    expect(w.opens).toEqual([['open', URL_]])
    expect(w.calls.some((c) => c.path.includes('/wake'))).toBe(false)
    expect(await text(pane)).toContain('Approve in your browser…')
    w.state.approval = 'denied'
    await w.clock.advance(2000)
    await pane.unmount()
  }
})

test('Open terminal opens the workspace in the app', async ($, on) => {
  const w = world(on, { agents: [AGENT] })
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await w.clock.advance(50)
  await pane.press({ key: 'cloud-term-agent-1' })
  await w.clock.advance(50)
  expect(w.opens).toEqual([['open', 'https://app.hiveop.io/hive/w-cloud']])
  await pane.unmount()
})

test('status refreshes when the view opens and slowly otherwise: never tighter than 30s', async ($, on) => {
  const w = world(on, { agents: [AGENT] })
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await w.clock.advance(50)
  const opened = agentFetches(w)
  expect(opened).toBeGreaterThanOrEqual(1)
  await w.clock.advance(20_000)
  expect(agentFetches(w)).toBe(opened)
  await pane.unmount()
  await w.clock.advance(120_000)
  const slow = agentFetches(w) - opened
  expect(slow).toBeGreaterThanOrEqual(1)
  expect(slow).toBeLessThanOrEqual(4)
})
