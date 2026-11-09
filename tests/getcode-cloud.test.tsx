import { expect, mock, test } from 'claude-code/testing'

// hcp-26: Get code for a HiveOp cloud repo. First time asks for approval in the
// browser; then it clones through a git credential helper. No token, no key and no
// credentialed URL anywhere in argv, env, the remote URL or the screen.

const HOME = '/home/ada'
const KEY = 'wm_ct_SECRETKEYSECRETKEY'
const TOKEN = 'forgejosecrettoken123'
const API = 'https://api.test/api/v1'
const ME = 'email:user-ada'
const REPO = 'https://git.hiveop.io/acme/cloudy'
const ORIGIN = 'https://git.hiveop.io'
const APPROVAL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002'
const URL_ = `https://app.hiveop.io/claude-code/approve?id=${APPROVAL_ID}`
const PANE = {
  plugin: 'hiveop',
  component: 'Pane',
  requestId: 'hiveop',
  props: { title: 'HiveOp', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const
const WSROWS = [
  { id: 'w-cloud', name: 'Cloudy', kind: 'cloud', githubRepoUrl: REPO },
  { id: 'w-norepo', name: 'Empty', kind: 'cloud', githubRepoUrl: '' },
  { id: 'w-gh', name: 'Press', kind: 'github', githubRepoUrl: 'https://github.com/acme/press' },
]

type World = {
  calls: { method: string; path: string; body: any }[]
  opens: string[][]
  runs: string[][]
  spawns: { argv: string[]; env?: Record<string, string> }[]
  state: { granted: boolean; statusCode: number; approval: 'pending' | 'approved' | 'denied' | 'expired'; stderr: string[]; code: number | null }
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
}

function world(on: any, state: Partial<World['state']> = {}): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 9, 12, 0) })
  const w: World = {
    calls: [], opens: [], runs: [], spawns: [], store: new Map(), clock,
    state: { granted: true, statusCode: 200, approval: 'pending', stderr: ['Receiving objects: 100% (10/10), done.\n'], code: 0, ...state },
  }
  mock.env(on, { HOME, HIVEOP_API_URL: API, TERM_PROGRAM: 'Apple_Terminal' })
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name ?? 'hiveop' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-123' }))
  on('session.end', (_: unknown, e: any) => ({ sessionId: e.sessionId }))
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv ?? []
    w.runs.push(argv)
    if (argv[0] === 'open') w.opens.push(argv)
    if (argv[0] === 'git' && argv[2] === 'remote') return { value: { exitCode: 128, stdout: '', stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('process.spawn', async function* (_: unknown, e: any) {
    w.spawns.push({ argv: e.argv, env: e.env })
    for (const text of w.state.stderr) yield { stream: 'stderr', text }
    return { value: { code: w.state.code, signal: null } }
  })
  on('fs.list', () => {
    throw new Error('ENOENT')
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
    if (path.endsWith('/cloud-agents')) return reply(200, { success: true, agents: [] })
    w.calls.push({ method, path, body })
    if (path === '/me/repo-access') {
      return w.state.statusCode === 200 ? reply(200, { success: true, granted: w.state.granted }) : reply(w.state.statusCode, { error: { code: 'PAT_FORBIDDEN', message: 'No.' } })
    }
    if (path === '/me/plugin-approvals' && method === 'POST') {
      return reply(201, { success: true, approval: { id: APPROVAL_ID, kind: 'repo_access', state: 'pending', expiresAt: new Date(Date.UTC(2026, 10, 9, 12, 10)).toISOString(), result: null } })
    }
    if (path === `/me/plugin-approvals/${APPROVAL_ID}`) {
      const st = w.state.approval
      return reply(200, { success: true, approval: { id: APPROVAL_ID, state: st, result: st === 'approved' ? { granted: true } : null } })
    }
    return reply(404)
  })
  return w
}

const text = async (ui: any) => JSON.stringify(await ui.drawn())
const start = async ($: any) => $.session.start({ cwd: '/tmp/x', surface: 'terminal', isInteractive: true })
async function workspaces($: any, surface: 'terminal' | 'desktop') {
  const pane = await $.ui.mount({ ...PANE, surface })
  if (await pane.find({ key: 'home-workspaces' })) await pane.press({ key: 'home-workspaces' })
  return pane
}
async function ready(w: World, $: any) {
  await start($)
  await w.clock.advance(50)
}
const launches = (w: World) => w.runs.filter((a) => a[0] === 'osascript')
const approvals = (w: World) => w.calls.filter((c) => c.method === 'POST' && c.path === '/me/plugin-approvals')
const HELPER = new RegExp(`^!sh '.*/bin/hiveop-git-credential' '${API.replace(/[/.]/g, '\\$&')}' 'w-cloud'$`)

test('a cloud row with a repo gets Get code; one without, or GitHub, does not offer the cloud flow', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  for (const surface of SURFACES) {
    const pane = await workspaces($, surface)
    expect(await pane.find({ key: 'ws-get-w-cloud' })).toBeDefined()
    expect(await pane.find({ key: 'ws-get-w-norepo' })).toBeUndefined()
    await pane.unmount()
  }
})

for (const surface of SURFACES) {
  test(`first Get code asks for approval, opens the page, shows the link, waits; approval then clones (${surface})`, async ($, on) => {
    const w = world(on, { granted: false })
    await ready(w, $)
    const pane = await workspaces($, surface)
    await pane.press({ key: 'ws-get-w-cloud' })
    await w.clock.advance(50)
    expect(approvals(w)).toHaveLength(1)
    expect(approvals(w)[0]!.body).toEqual({ kind: 'repo_access' })
    expect(w.opens).toEqual([['open', URL_]])
    const shown = await text(pane)
    expect(shown).toContain('Approve in your browser…')
    expect(shown).toContain(URL_)
    expect(w.spawns).toHaveLength(0)
    await w.clock.advance(2000)
    expect(w.spawns).toHaveLength(0)
    w.state.approval = 'approved'
    await w.clock.advance(2000)
    await w.clock.advance(50)
    expect(w.spawns).toHaveLength(1)
    expect(await text(pane)).not.toContain('Approve in your browser…')
    // Once granted, the next Get code (a fresh row) would not ask again.
    expect(approvals(w)).toHaveLength(1)
    await pane.unmount()
  })
}

test('with a grant already, Get code clones straight away and asks for nothing', async ($, on) => {
  const w = world(on, { granted: true })
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-get-w-cloud' })
  await w.clock.advance(50)
  expect(approvals(w)).toHaveLength(0)
  expect(w.opens).toHaveLength(0)
  expect(w.spawns).toHaveLength(1)
  await pane.unmount()
})

test('clone goes through the helper: no credential in the URL, argv or env, key never shown', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-get-w-cloud' })
  await w.clock.advance(50)
  const { argv, env } = w.spawns[0]!
  const key = `credential.${ORIGIN}.helper`
  expect(argv.slice(0, 5)).toEqual(['git', '-c', `${key}=`, '-c', expect.stringMatching(new RegExp(`^${key.replace(/\./g, '\\.')}=!sh `))])
  expect(argv[4]!.slice(key.length + 1)).toMatch(HELPER)
  expect(argv.slice(5)).toEqual(['clone', '--progress', '--', REPO, '/home/ada/HiveOp/cloudy'])
  expect(env).toEqual({ GIT_TERMINAL_PROMPT: '0' })
  for (const bad of [KEY, TOKEN, 'Bearer', 'x-access-token']) {
    expect(JSON.stringify(w.spawns)).not.toContain(bad)
    expect(JSON.stringify(w.runs)).not.toContain(bad)
    expect(await text(pane)).not.toContain(bad)
  }
  expect(argv.includes('@') || REPO.includes('@')).toBe(false)
  // Push works the same way: the clone's own config names the helper (reset first, so no stored login is used).
  const cfg = w.runs.filter((a) => a[0] === 'git' && a.includes('config'))
  expect(cfg).toHaveLength(2)
  expect(cfg[0]).toEqual(['git', '-C', '/home/ada/HiveOp/cloudy', 'config', '--local', '--add', key, ''])
  expect(cfg[1]!.slice(0, 6)).toEqual(['git', '-C', '/home/ada/HiveOp/cloudy', 'config', '--local', '--add'])
  expect(cfg[1]![6]).toBe(key)
  expect(cfg[1]![7]).toMatch(HELPER)
  expect(w.store.get('clones.byRemote')).toEqual({ 'git.hiveop.io/acme/cloudy': '/home/ada/HiveOp/cloudy' })
  await pane.unmount()
})

test('terminal launches Claude Code in the clone', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  const t = await workspaces($, 'terminal')
  await t.press({ key: 'ws-get-w-cloud' })
  await w.clock.advance(50)
  expect(launches(w)).toHaveLength(1)
  expect(await text(t)).toContain('Opened Cloudy')
  await t.unmount()
})

test('desktop clones and shows the command, launching nothing', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  const d = await workspaces($, 'desktop')
  await d.press({ key: 'ws-get-w-cloud' })
  await w.clock.advance(50)
  expect(w.spawns).toHaveLength(1)
  expect(launches(w)).toHaveLength(0)
  expect(await text(d)).toContain("cd '/home/ada/HiveOp/cloudy' && claude")
  await d.unmount()
})

for (const surface of SURFACES) {
  test(`denied says Not approved. and clones nothing (${surface})`, async ($, on) => {
    const w = world(on, { granted: false, approval: 'denied' })
    await ready(w, $)
    const pane = await workspaces($, surface)
    await pane.press({ key: 'ws-get-w-cloud' })
    await w.clock.advance(2100)
    expect(await text(pane)).toContain('Not approved.')
    expect(w.spawns).toHaveLength(0)
    await pane.unmount()
  })
}

test('expired by the server says Request expired. and clones nothing', async ($, on) => {
  const w = world(on, { granted: false, approval: 'expired' })
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-get-w-cloud' })
  await w.clock.advance(2100)
  expect(await text(pane)).toContain('Request expired.')
  expect(w.spawns).toHaveLength(0)
  await pane.unmount()
})

test('expired by the clock (never answered) says Request expired.', async ($, on) => {
  const w = world(on, { granted: false, approval: 'pending' })
  await ready(w, $)
  const pane = await workspaces($, 'desktop')
  await pane.press({ key: 'ws-get-w-cloud' })
  await w.clock.advance(11 * 60_000)
  expect(await text(pane)).toContain('Request expired.')
  expect(w.spawns).toHaveLength(0)
  await pane.unmount()
})

test('revoked before the clone: one line, no request, no clone', async ($, on) => {
  const w = world(on, { statusCode: 403 })
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-get-w-cloud' })
  await w.clock.advance(50)
  expect(await text(pane)).toContain('Repo access revoked.')
  expect(w.spawns).toHaveLength(0)
  expect(approvals(w)).toHaveLength(0)
  await pane.unmount()
})

test('revoked during the clone (the helper says so): one line, nothing kept', async ($, on) => {
  const w = world(on, { stderr: ['fatal: could not read Password for ' + ORIGIN + '\n', 'hiveop-git-credential: revoked\n'], code: 128 })
  await ready(w, $)
  const pane = await workspaces($, 'desktop')
  await pane.press({ key: 'ws-get-w-cloud' })
  await w.clock.advance(50)
  const shown = await text(pane)
  expect(shown).toContain('Repo access revoked.')
  expect(shown).not.toContain('fatal:')
  expect(launches(w)).toHaveLength(0)
  expect(w.store.get('clones.byRemote')).toBeUndefined()
  await pane.unmount()
})

test('any other clone failure is just Clone failed.', async ($, on) => {
  const w = world(on, { stderr: ['fatal: boom ' + REPO + '\n'], code: 1 })
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-get-w-cloud' })
  await w.clock.advance(50)
  const shown = await text(pane)
  expect(shown).toContain('Clone failed.')
  expect(shown).not.toContain('boom')
  await pane.unmount()
})
