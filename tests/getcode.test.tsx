import { expect, mock, test } from 'claude-code/testing'

import { cloneFailureLine, cloneableUrl, lastPercent, slugify } from '../hooks/launch'

const HOME = '/home/ada'
const KEY = 'wm_ct_SECRETKEYSECRETKEY'
const API = 'https://api.test/api/v1'
const ME = 'email:user-ada'
const SECRET_URL = 'https://x-access-token:ghp_TOPSECRET@github.com/acme/press.git'
const PANE = {
  plugin: 'hiveop',
  component: 'Pane',
  requestId: 'hiveop',
  props: { title: 'HiveOp', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const

const WSROWS = [
  { id: 'w-press', name: 'Press Room!', kind: 'github', githubRepoUrl: 'https://github.com/acme/press' },
  { id: 'w-cloud', name: 'Cloudy', kind: 'cloud', githubRepoUrl: '' },
  { id: 'w-bare', name: 'Bare', kind: 'github', githubRepoUrl: '' },
]

type Spawn = { code: number | null; stderr: string[]; throws?: boolean; gate?: Promise<void> }
type World = {
  store: Map<string, unknown>
  runs: string[][]
  spawns: { argv: string[]; env?: Record<string, string> }[]
  spawn: Spawn
  origins: Record<string, string>
  dirs: Record<string, string[]>
  clock: ReturnType<typeof mock.clock>
}

function world(on: any, start: Partial<World> = {}): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 9, 12, 0) })
  const w: World = {
    store: new Map(),
    runs: [],
    spawns: [],
    spawn: { code: 0, stderr: ['Cloning into...\n', 'Receiving objects:  10% (1/10)\r', 'Receiving objects:  60% (6/10)\r', 'Receiving objects: 100% (10/10), done.\n'] },
    origins: {},
    dirs: {},
    clock,
    ...start,
  }
  mock.env(on, { HOME, HIVEOP_API_URL: API, TERM_PROGRAM: 'Apple_Terminal' })
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name ?? 'hiveop' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-123' }))
  on('session.end', (_: unknown, e: any) => ({ sessionId: e.sessionId }))
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv ?? []
    w.runs.push(argv)
    if (argv[0] === 'git') {
      const o = w.origins[argv[2]!]
      return o === undefined ? { value: { exitCode: 128, stdout: '', stderr: 'not a repo' } } : { value: { exitCode: 0, stdout: o + '\n', stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('process.spawn', async function* (_: unknown, e: any) {
    w.spawns.push({ argv: e.argv, env: e.env })
    if (w.spawn.throws) throw new Error('no git')
    for (const text of w.spawn.stderr) yield { stream: 'stderr', text }
    if (w.spawn.gate) await w.spawn.gate
    return { value: { code: w.spawn.code, signal: null } }
  })
  on('fs.list', (_: unknown, e: any) => {
    const names = w.dirs[String(e.path).replace(/\/+$/, '')]
    if (!names) throw new Error('ENOENT')
    return { value: names.map((name) => ({ name, kind: 'dir', size: 0, mtimeMs: 0 })) }
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
    const reply = (status: number, body: unknown = {}) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
    if (path.startsWith('/me/hive/profile')) return reply(200, { profile: { displayName: 'Ada', walletPubkey: ME } })
    if (path.startsWith('/me/workspaces/match')) return reply(200, { success: true, mine: [], joinable: [] })
    if (path === '/workspaces') return reply(200, { workspaces: WSROWS })
    if (path.startsWith('/me/sync')) return reply(200, { cursor: 'c0', events: [], timedOut: true })
    if (path.endsWith('/work-summary')) return reply(200, { success: true, ready: 0, inProgress: 0, next: null })
    void method
    return reply(404)
  })
  return w
}

const text = async (ui: any) => JSON.stringify(await ui.drawn())
const start = async ($: any) => $.session.start({ cwd: '/tmp/x', surface: 'terminal', isInteractive: true })
const launches = (w: World) => w.runs.filter((a) => a[0] === 'osascript')
async function workspaces($: any, surface: 'terminal' | 'desktop') {
  const pane = await $.ui.mount({ ...PANE, surface })
  if (await pane.find({ key: 'home-workspaces' })) await pane.press({ key: 'home-workspaces' })
  return pane
}
async function ready(w: World, $: any) {
  await start($)
  await w.clock.advance(50)
}

test('only a GitHub workspace with a repo gets Get code', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  for (const surface of SURFACES) {
    const pane = await workspaces($, surface)
    expect(await pane.find({ key: 'ws-get-w-press' })).toBeDefined()
    expect(await pane.find({ key: 'ws-get-w-cloud' })).toBeUndefined()
    expect(await pane.find({ key: 'ws-get-w-bare' })).toBeUndefined()
    await pane.unmount()
  }
})

test('clone success remembers the folder and runs Open', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-get-w-press' })
  await w.clock.advance(50)
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.argv).toEqual(['git', 'clone', '--progress', '--', 'https://github.com/acme/press', '/home/ada/HiveOp/press-room'])
  expect(w.spawns[0]!.env).toEqual({ GIT_TERMINAL_PROMPT: '0' })
  expect(w.store.get('clones.byRemote')).toEqual({ 'github.com/acme/press': '/home/ada/HiveOp/press-room' })
  expect(launches(w)).toHaveLength(1)
  expect(launches(w)[0]!.join(' ')).toContain("cd '/home/ada/HiveOp/press-room' && claude")
  expect(Object.values(w.store.get('join.open') as Record<string, { ws: string }>).map((v) => v.ws)).toEqual(['w-press'])
  expect(await text(pane)).toContain('Opened Press Room!')
  expect(await pane.find({ key: 'ws-open-w-press' })).toBeDefined()
  expect(await pane.find({ key: 'ws-get-w-press' })).toBeUndefined()
  await pane.unmount()
})

test('on desktop the clone runs and the command is shown, nothing launched', async ($, on) => {
  const w = world(on)
  await ready(w, $)
  const pane = await workspaces($, 'desktop')
  await pane.press({ key: 'ws-get-w-press' })
  await w.clock.advance(50)
  expect(w.spawns).toHaveLength(1)
  expect(launches(w)).toHaveLength(0)
  expect(await text(pane)).toContain("cd '/home/ada/HiveOp/press-room' && claude")
  await pane.unmount()
})

test('a name collision with another repo gets -2, then -3', async ($, on) => {
  const w = world(on, {
    dirs: { '/home/ada/HiveOp/press-room': [], '/home/ada/HiveOp/press-room-2': [] },
    origins: { '/home/ada/HiveOp/press-room': 'https://github.com/acme/other', '/home/ada/HiveOp/press-room-2': 'git@github.com:acme/another.git' },
  })
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-get-w-press' })
  await w.clock.advance(50)
  expect(w.spawns[0]!.argv.at(-1)).toBe('/home/ada/HiveOp/press-room-3')
  await pane.unmount()
})

test('a folder that already is this repo is found, not cloned again', async ($, on) => {
  const w = world(on, { dirs: { '/home/ada/HiveOp/press-room': [] }, origins: { '/home/ada/HiveOp/press-room': 'git@github.com:acme/press.git' } })
  // The folder holds the repo but is not in the scan, so the row still says Get code.
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-get-w-press' })
  await w.clock.advance(50)
  expect(w.spawns).toHaveLength(0)
  expect(launches(w)).toHaveLength(1)
  expect(w.store.get('clones.byRemote')).toEqual({ 'github.com/acme/press': '/home/ada/HiveOp/press-room' })
  await pane.unmount()
})

test('a stalled clone shows Cloning and its last percentage', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const w = world(on, { spawn: { code: 0, stderr: ['Receiving objects:  10% (1/10)\r', 'Receiving objects:  42% (4/10)\r'], gate } })
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  void pane.press({ key: 'ws-get-w-press' })
  await w.clock.advance(50)
  expect(await text(pane)).toContain('Cloning Press Room!… 42%')
  release()
  await w.clock.advance(50)
  expect(await text(pane)).toContain('Opened Press Room!')
  await pane.unmount()
})

test('an auth failure says so in one line and leaks nothing', async ($, on) => {
  const w = world(on, {
    spawn: {
      code: 128,
      stderr: [`Cloning into '/home/ada/HiveOp/press-room'...\n`, `remote: Invalid username or password.\nfatal: Authentication failed for '${SECRET_URL}'\n`],
    },
  })
  await ready(w, $)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-get-w-press' })
  await w.clock.advance(50)
  const shown = await text(pane)
  expect(shown).toContain('No GitHub access to this repo.')
  for (const bad of ['ghp_TOPSECRET', 'x-access-token', 'fatal:', 'Invalid username']) expect(shown).not.toContain(bad)
  expect(launches(w)).toHaveLength(0)
  expect(w.store.get('clones.byRemote')).toBeUndefined()
  expect(await pane.find({ key: 'ws-get-w-press' })).toBeDefined()
  await pane.unmount()
})

async function failsWith(on: any, $: any, spawn: Spawn) {
  const w = world(on, { spawn })
  await ready(w, $)
  const pane = await workspaces($, 'desktop')
  await pane.press({ key: 'ws-get-w-press' })
  await w.clock.advance(50)
  const shown = await text(pane)
  expect(shown).toContain('Clone failed.')
  expect(shown).not.toContain('TOPSECRET')
  expect(launches(w)).toHaveLength(0)
  await pane.unmount()
}

test('any other failure is just Clone failed, with no git output', async ($, on) => {
  await failsWith(on, $, { code: 1, stderr: ['fatal: disk exploded at ' + SECRET_URL + '\n'] })
})

test('a git that will not start is Clone failed too', async ($, on) => {
  await failsWith(on, $, { code: null, stderr: [], throws: true })
})

test('pure helpers: slug, url, percent, failure line', () => {
  expect(slugify('Press Room!')).toBe('press-room')
  expect(slugify('../../etc')).toBe('etc')
  expect(slugify('日本')).toBe('workspace')
  expect(cloneableUrl('https://github.com/acme/press')).toBe(true)
  expect(cloneableUrl('git@github.com:acme/press.git')).toBe(true)
  expect(cloneableUrl(SECRET_URL)).toBe(false)
  expect(cloneableUrl('--upload-pack=evil')).toBe(false)
  expect(cloneableUrl('')).toBe(false)
  expect(lastPercent('Receiving objects:  10% (1/10)\rReceiving objects:  60% (6/10)\r')).toBe(60)
  expect(lastPercent('Cloning into x')).toBeNull()
  expect(cloneFailureLine('fatal: Authentication failed for https://u:p@github.com/a/b')).toBe('No GitHub access to this repo.')
  expect(cloneFailureLine('ERROR: Repository not found.')).toBe('No GitHub access to this repo.')
  expect(cloneFailureLine('fatal: unable to access: Could not resolve host')).toBe('Clone failed.')
})
