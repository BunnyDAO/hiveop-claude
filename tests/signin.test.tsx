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
  clock: ReturnType<typeof mock.clock>
}

// The world beneath the plugin: HiveOp's API, a file system, the machine.
function world(on: any, start: Partial<Omit<World, 'clock'>> = {}): World {
  const clock = mock.clock(on, { now: Date.now() })
  const w: World = {
    clock,
    offline: false,
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

test('signed out: the band offers Sign in and nothing polls', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Not signed in/ })).toBeDefined()
    expect(await ui.find({ key: 'band-sign-in' })).toBeDefined()
    await ui.unmount()
  }
  await w.clock.advance(60_000)
  expect(w.calls).toHaveLength(0)
})

test('sign in: code and link show, approval stores the key user-only and the band shows the name', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const clock = w.clock

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    await pane.press({ key: 'sign-in' })
    const shown = await text(pane)
    expect(shown).toContain('HIVE-K7QP')
    expect(shown).toContain('https://app.hiveop.io/claude-code?code=HIVE-K7QP')
    expect(shown).not.toContain('poll-secret')
    await pane.unmount()
    break
  }

  const create = w.calls.find((c) => c.url.endsWith('/pairing/codes'))!
  expect(create.url).toBe('https://api.test/api/v1/pairing/codes')
  expect(JSON.parse(create.body)).toEqual({ deviceLabel: 'Adas-MacBook', purpose: 'plugin' })
  expect(create.headers['X-HiveOp-Client']).toBe('claude-code-plugin')
  expect(create.headers['X-HiveOp-Client-Version']).toMatch(/^\d+\.\d+\.\d+$/)

  await clock.advance(3000) // still pending
  expect(w.files.size).toBe(0)

  w.poll = { status: 'approved' }
  await clock.advance(3000)

  const file = w.files.get(`${HOME}/.hiveop/claude-plugin.json`)
  expect(file).toBeDefined()
  expect(JSON.parse(file!).key).toBe(KEY)
  expect(w.ran.some((a) => a[0] === 'chmod' && a[1] === '600')).toBe(true)
  expect(w.ran.some((a) => a[0] === 'mkdir' && a.includes('700'))).toBe(true)

  const me = w.calls.find((c) => c.url.endsWith('/me/hive/profile'))!
  expect(me.headers.Authorization).toBe(`Bearer ${KEY}`)
  expect(me.headers['X-HiveOp-Client']).toBe('claude-code-plugin')

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    const shown = await text(band)
    expect(shown).toContain('Ada')
    expect(shown).not.toContain(KEY)
    expect(shown).not.toContain('Sign in')
    await band.unmount()
  }

  // Polling stopped on approval.
  const pairing = () => w.calls.filter((c) => c.url.includes('/pairing/')).length
  const before = pairing()
  await clock.advance(30_000)
  expect(pairing()).toBe(before)
})

test('the key never reaches command output', async ($, on) => {
  const w = world(on, { poll: { status: 'approved' } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const clock = w.clock
  const out = await $.command.run({ command: 'hiveop', args: 'sign-in', ...RUN })
  await clock.advance(3000)
  const again = await $.command.run({ command: 'hiveop', args: '', ...RUN })
  expect(JSON.stringify([out, again])).not.toContain(KEY)
  expect(JSON.stringify([out, again])).not.toContain('poll-secret')
  expect(w.files.size).toBe(1)
})

for (const [name, poll, words] of [
  ['denied', { status: 'denied' }, /denied/i],
  ['expired', { status: 'expired' }, /expired/i],
  ['not open yet', { status: 'denied', reason: 'not_open' }, /isn't open yet/],
] as const) {
  test(`sign in ${name}: the band says so and polling stops`, async ($, on) => {
    const w = world(on, { poll: { ...poll } })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const clock = w.clock
    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await pane.press({ key: 'sign-in' })
    await clock.advance(3000)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await text(band)).toMatch(words)
    expect(w.files.size).toBe(0)
    const before = w.calls.length
    await clock.advance(30_000)
    expect(w.calls.length).toBe(before)
    await band.unmount()
    await pane.unmount()
  })
}

test('timeout: a code left unapproved past its time ends as expired', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const clock = w.clock
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'sign-in' })
  await clock.advance(11 * 60_000)
  expect(await text(pane)).toMatch(/expired/i)
  await pane.unmount()
})

test('HiveOp unreachable at sign in is said plainly', async ($, on) => {
  world(on, { offline: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'sign-in' })
  expect(await text(pane)).toMatch(/reach HiveOp/)
  await pane.unmount()
})

test('a stored key restores the signed-in band; sign out forgets it and nothing polls', async ($, on) => {
  const w = world(on, { files: new Map([[`${HOME}/.hiveop/claude-plugin.json`, JSON.stringify({ key: KEY })]]) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await text(pane)).toContain('Ada')
  await pane.press({ key: 'sign-out' })
  // hcp-14: the server revokes this key, with the key, before the file goes.
  const revoke = w.calls.find((c) => c.url.endsWith('/me/plugin-key') && c.method === 'DELETE')
  expect(revoke?.headers.Authorization ?? revoke?.headers.authorization).toBe(`Bearer ${KEY}`)
  expect(w.ran.some((a) => a[0] === 'rm' && a.some((x) => x.endsWith('claude-plugin.json')))).toBe(true)
  expect(await text(pane)).toContain('Sign in')
  await w.clock.advance(60_000)
  expect(w.calls.filter((c) => c.url.endsWith('/pairing/poll'))).toHaveLength(0)
  await pane.unmount()
})

test('sign out still forgets the key when HiveOp is unreachable', async ($, on) => {
  const w = world(on, { files: new Map([[`${HOME}/.hiveop/claude-plugin.json`, JSON.stringify({ key: KEY })]]) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await text(pane)).toContain('Ada')
  w.offline = true
  await pane.press({ key: 'sign-out' })
  expect(w.ran.some((a) => a[0] === 'rm' && a.some((x) => x.endsWith('claude-plugin.json')))).toBe(true)
  expect(await text(pane)).toContain('Sign in')
  await pane.unmount()
})

test('a key HiveOp rejects is forgotten', async ($, on) => {
  const w = world(on, { files: new Map([[`${HOME}/.hiveop/claude-plugin.json`, JSON.stringify({ key: KEY })]]), profileStatus: 401 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await text(band)).toMatch(/no longer accepts/)
  expect(w.ran.some((a) => a[0] === 'rm')).toBe(true)
  await band.unmount()
})
