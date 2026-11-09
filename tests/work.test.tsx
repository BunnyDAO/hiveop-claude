import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/ada'
const KEY = 'wm_ct_SECRETKEYSECRETKEY'
const API = 'https://api.test/api/v1'
const WS = 'ws-1'
const ME = 'email:user-ada'
const BAND = { plugin: 'hiveop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const PANE = {
  plugin: 'hiveop',
  component: 'Pane',
  requestId: 'hiveop',
  props: { title: 'HiveOp', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const
const GAP = 3_500

type Summary = { ready: number; inProgress: number; next: { id: string; title: string } | null }
type World = {
  clock: ReturnType<typeof mock.clock>
  calls: { path: string; method: string }[]
  toasts: string[]
  logs: string[]
  summary: Summary
  pending: Record<string, unknown>[]
  claimReply: { status: number; body: unknown }
  answers: string[]
  placed: boolean
}

function world(on: any, start: Partial<World> = {}): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 8, 12, 0) })
  const w: World = {
    clock,
    calls: [],
    toasts: [],
    logs: [],
    summary: { ready: 3, inProgress: 1, next: { id: 'i1', title: 'Fix the login bug' } },
    pending: [],
    claimReply: { status: 200, body: { success: true, issue: { id: 'i1' } } },
    answers: [],
    placed: true,
    ...start,
  }
  mock.env(on, { HOME, HIVEOP_API_URL: API })
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name ?? 'hiveop' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('fs.read', () => ({ value: JSON.stringify({ key: KEY }) }))
  const store = new Map<string, unknown>()
  on('store.get', (_: unknown, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: w.placed ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  on('ui.panes', () => ({ value: w.placed ? [{ id: 'hiveop', title: 'HiveOp', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.toast', (_: unknown, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_: unknown, e: any) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: any) => {
    const q = e.questions[0]
    const a = w.answers.shift()
    if (a === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: a } } }
  })
  on('http.fetch', (_: unknown, e: any) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace(API, '')
    w.calls.push({ path, method })
    const reply = (status: number, body: unknown = {}) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
    if (path.startsWith('/me/hive/profile')) return reply(200, { profile: { displayName: 'Ada', walletPubkey: ME } })
    if (path === '/workspaces') return reply(200, { workspaces: [{ id: WS, name: 'Forge' }] })
    if (path.startsWith('/me/sync')) {
      if (!path.includes('cursor=')) return reply(200, { cursor: 'c0', events: [], timedOut: false })
      const events = w.pending
      w.pending = []
      return reply(200, { cursor: 'c1', events, timedOut: events.length === 0 })
    }
    if (path.startsWith(`/workspaces/${WS}/chat`)) return reply(200, { messages: [] })
    if (path === `/workspaces/${WS}/work-summary`) return reply(200, { success: true, ...w.summary })
    if (/^\/workspaces\/ws-1\/issues\/i\d\/claim$/.test(path) && method === 'POST') return reply(w.claimReply.status, w.claimReply.body)
    return reply(404)
  })
  return w
}

const text = async (ui: any) => JSON.stringify(await ui.drawn())
const start = async ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const claims = (w: World) => w.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/claim'))
const summaries = (w: World) => w.calls.filter((c) => c.path.endsWith('/work-summary'))
const change = (action: string, title: string, status = 'open', assigneeWallet: string | null = null, workspaceId = WS) => ({
  type: 'workspace:issue_changed',
  workspaceId,
  action,
  issue: { id: 'x' + title, title, status, priority: 1, assigneeWallet },
})

test('band: counts, next title and a Claim button, on both surfaces', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    const shown = await text(band)
    expect(shown).toContain('3 ready · 1 in progress · next: Fix the login bug')
    expect(await band.find({ key: 'band-claim' })).toBeDefined()
    await band.unmount()
  }
})

test('no ready work: no Claim button', async ($, on) => {
  const w = world(on, { summary: { ready: 0, inProgress: 2, next: null } })
  await start($)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const shown = await text(band)
  expect(shown).toContain('0 ready · 2 in progress')
  expect(shown).not.toContain('band-claim')
  await band.unmount()
})

test('Claim claims the top ready item as the person and the band refreshes', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  w.summary = { ready: 2, inProgress: 2, next: { id: 'i2', title: 'Next one' } }
  w.claimReply = { status: 200, body: { success: true } }
  await band.press({ key: 'band-claim' })
  expect(w.toasts.some((t) => t.includes('Claimed: Next one'))).toBe(true)
  expect(claims(w)).toHaveLength(1)
  // Fetched fresh at press time: the item that is next NOW, not the band's stale one.
  expect(claims(w)[0]!.path).toBe(`/workspaces/${WS}/issues/i2/claim`)
  const shown = await text(band)
  expect(shown).toContain('2 ready · 2 in progress · next: Next one')
  await band.unmount()
})

test('a refusal shows the server\'s own words (one claim at a time)', async ($, on) => {
  const msg = 'You already hold "Other" in this workspace. Submit or release it before claiming another mission.'
  const w = world(on, { claimReply: { status: 409, body: { success: false, error: { code: 'ONE_CLAIM_AT_A_TIME', message: msg } } } })
  await start($)
  await w.clock.advance(50)
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    await pane.press({ key: 'home-claim' })
    expect(await text(pane)).toContain('You already hold')
    await pane.unmount()
  }
  expect(w.toasts.join('\n')).toContain('You already hold')
})

test('home: Claim next is enabled and shows the counts', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    const shown = await text(pane)
    expect(shown).toContain('"label":"Claim next"')
    expect(shown).toContain('3 ready · 1 in progress · next: Fix the login bug')
    await pane.press({ key: 'home-claim' })
    await pane.unmount()
  }
  expect(claims(w)).toHaveLength(2) // one press per surface
})

test('sync work events: toasts for new, claimed and done; no polling for counts', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  const before = summaries(w).length
  w.pending = [change('create', 'Brand new'), change('claim', 'Taken', 'in_progress', 'BeaWallet'), change('update', 'Finished', 'closed')]
  await w.clock.advance(GAP * 2)
  expect(w.toasts).toEqual(['HiveOp · new: Brand new', 'HiveOp · claimed: Taken', 'HiveOp · done: Finished'])
  expect(summaries(w).length).toBe(before + 1) // refreshed once, from the event
  await w.clock.advance(60_000)
  expect(summaries(w).length).toBe(before + 1) // and not again on a timer
})

test('at most three toasts at once; your own claim is not announced', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  w.pending = [change('create', 'A'), change('create', 'B'), change('create', 'C'), change('create', 'D'), change('claim', 'Mine', 'in_progress', ME)]
  await w.clock.advance(GAP * 2)
  expect(w.toasts).toHaveLength(3)
  expect(w.toasts[2]).toBe('HiveOp · +2 more')
  expect(w.toasts.join('\n')).not.toContain('Mine')
})

test('an event in another workspace toasts but does not refetch this one', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  const before = summaries(w).length
  w.pending = [change('create', 'Elsewhere', 'open', null, 'ws-other')]
  await w.clock.advance(GAP * 2)
  expect(w.toasts).toEqual(['HiveOp · new: Elsewhere'])
  expect(summaries(w).length).toBe(before)
})

test('narrow: More → Claim next claims; titles only in notices, command output neutral', async ($, on) => {
  const w = world(on, { answers: ['More', 'Claim next'], placed: false })
  await start($)
  await w.clock.advance(50)
  const out = await $.command.run({ command: 'hiveop', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 60 } })
  expect(claims(w)).toHaveLength(1)
  expect(w.logs.join('\n')).toContain('Fix the login bug')
  expect(JSON.stringify(out)).not.toContain('Fix the login bug')
})
