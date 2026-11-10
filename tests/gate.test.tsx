import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/ada'
const KEY = 'wm_ct_SECRETKEYSECRETKEY'
const BAND = { plugin: 'hiveop', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const PANE = {
  plugin: 'hiveop',
  component: 'Pane',
  requestId: 'hiveop',
  props: { title: 'HiveOp', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const SURFACES = ['terminal', 'desktop'] as const

type World = {
  files: Map<string, string>
  calls: { url: string; method: string; headers: Record<string, string>; body: string }[]
  ran: string[][]
  poll: { status: string; reason?: string }
  profileStatus: number
  offline: boolean
  gate: { state: string; message?: string | null }
  keyed: number
  clock: ReturnType<typeof mock.clock>
}

// The world beneath the plugin: HiveOp's API, a file system, the machine.
function world(on: any, start: Partial<Omit<World, 'clock'>> = {}): World {
  const clock = mock.clock(on, { now: Date.now() })
  const w: World = {
    clock,
    offline: false,
    gate: { state: 'ok' },
    keyed: 200,
    files: new Map(),
    calls: [],
    ran: [],
    poll: { status: 'pending' },
    profileStatus: 200,
    ...start,
  }
  mock.env(on, { HOME, HIVEOP_API_URL: 'https://api.test/api/v1' })
  const store = new Map<string, unknown>()
  on('store.get', (_: unknown, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'hiveop' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('process.run', (_: unknown, e: any) => {
    w.ran.push([...e.argv])
    if (e.argv[0] === 'hostname') return { value: { exitCode: 0, stdout: 'Adas-MacBook.local\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('fs.read', (_: unknown, e: any) => {
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_: unknown, e: any) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('http.fetch', (_: unknown, e: any) => {
    if (w.offline) throw new Error('offline')
    const method = e.init?.method ?? 'GET'
    w.calls.push({ url: e.url, method, headers: e.init?.headers ?? {}, body: e.init?.body ?? '' })
    const reply = (status: number, body: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
    if (e.url.includes('/client-gate?')) {
      return reply(200, { success: true, state: w.gate.state, minVersion: w.gate.state === 'update' ? '0.9.0' : null, message: w.gate.message ?? null })
    }
    if (w.keyed === 426) return reply(426, { success: false, error: { code: 'CLIENT_UPDATE_REQUIRED', message: 'Please update HiveOp for Claude Code.', minVersion: '0.9.0' } })
    if (w.keyed === 503) return reply(503, { success: false, error: { code: 'CLIENT_PAUSED', message: 'Back soon.' } })
    if (e.url.endsWith('/pairing/codes')) {
      return reply(201, { success: true, code: 'HIVE-K7QP', pollToken: 'poll-secret', expiresAt: new Date(clock.now() + 600_000).toISOString() })
    }
    if (e.url.endsWith('/pairing/poll')) {
      return reply(200, w.poll.status === 'approved' ? { success: true, status: 'approved', purpose: 'plugin', connectToken: KEY } : { success: true, ...w.poll })
    }
    if (e.url.endsWith('/me/hive/profile')) {
      return reply(w.profileStatus, { success: true, profile: { displayName: 'Ada' }, agents: [] })
    }
    return reply(404, {})
  })
  return w
}

async function text(ui: any) {
  return JSON.stringify(await ui.drawn())
}

const stored = () => new Map([[`${HOME}/.hiveop/claude-plugin.json`, JSON.stringify({ key: KEY })]])
const syncCalls = (w: World) => w.calls.filter((c) => c.url.includes('/me/sync')).length

test('hcp-02: a too-old plugin says update, with the command, and keeps its key', async ($, on) => {
  const w = world(on, { files: stored(), gate: { state: 'update' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const check = w.calls.find((c) => c.url.includes('/client-gate?'))
  expect(check?.url).toContain('kind=claude-code-plugin')
  expect(check?.url).toMatch(/version=\d+\.\d+\.\d+/)
  expect(check?.headers.Authorization).toBeUndefined()
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await text(band)).toContain('Please update HiveOp')
    expect(await band.find({ key: 'band-sign-in' })).toBeUndefined()
    await band.unmount()
  }
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await text(pane)).toContain('claude plugin update hiveop')
  await pane.unmount()
  await w.clock.advance(120_000)
  expect(syncCalls(w)).toBe(0)
  expect(w.ran.some((a) => a[0] === 'rm')).toBe(false)
})

test('hcp-02: paused goes quiet, shows the message, and comes back when reopened', async ($, on) => {
  const w = world(on, { files: stored(), gate: { state: 'off', message: 'Back soon.' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await text(band)).toContain('Back soon.')
  const before = w.calls.length
  await w.clock.advance(5 * 60_000)
  expect(w.calls.length).toBe(before)
  w.gate = { state: 'ok' }
  await w.clock.advance(15 * 60_000)
  expect(await text(band)).toContain('Ada')
  await band.unmount()
})

test('hcp-02: a 503 CLIENT_PAUSED mid-session stops polling and says paused', async ($, on) => {
  const w = world(on, { files: stored() })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await text(band)).toContain('Ada')
  w.keyed = 503
  await w.clock.advance(60_000)
  expect(await text(band)).toContain('Back soon.')
  const after = syncCalls(w)
  await w.clock.advance(5 * 60_000)
  expect(syncCalls(w)).toBe(after)
  expect(w.ran.some((a) => a[0] === 'rm')).toBe(false)
  await band.unmount()
})

test('hcp-02: a 426 mid-session says update', async ($, on) => {
  const w = world(on, { files: stored() })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  w.keyed = 426
  await w.clock.advance(60_000)
  expect(await text(band)).toContain('Please update HiveOp')
  await band.unmount()
})

test('hcp-02: sign in while paused does not start pairing', async ($, on) => {
  const w = world(on, { gate: { state: 'off' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'sign-in' })
  expect(w.calls.some((c) => c.url.endsWith('/pairing/codes'))).toBe(false)
  expect(await text(pane)).toContain('paused')
  await pane.unmount()
})
