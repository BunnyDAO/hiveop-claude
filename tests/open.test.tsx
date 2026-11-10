import { expect, mock, test } from 'claude-code/testing'

import { folderKey } from '../hooks/client'
import { claudeCommand, inlinePluginDir, launchArgv, normRemote } from '../hooks/launch'

const HOME = '/home/ada'
const KEY = 'wm_ct_SECRETKEYSECRETKEY'
const API = 'https://api.test/api/v1'
const ME = 'email:user-ada'
const CWD = '/home/ada/code/forge'
const PANE = {
  plugin: 'hiveop',
  component: 'Pane',
  requestId: 'hiveop',
  props: { title: 'HiveOp', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const

// Workspaces: Forge (this folder), Anvil (clone next door), Lathe (clone in ~/HiveOp), Kiln (remembered), Press (no clone).
const REPOS: Record<string, string> = {
  forge: 'https://github.com/acme/forge',
  anvil: 'https://github.com/acme/anvil.git',
  lathe: 'https://github.com/acme/lathe',
  kiln: 'https://github.com/acme/kiln',
  press: 'https://github.com/acme/press',
}
const WSROWS = Object.keys(REPOS).map((n) => ({ id: `w-${n}`, name: n[0]!.toUpperCase() + n.slice(1), kind: 'github', githubRepoUrl: REPOS[n] }))

type World = {
  clock: ReturnType<typeof mock.clock>
  store: Map<string, unknown>
  term: string
  runs: string[][]
  launchExit: number
  launchThrows: boolean
  // folder -> origin as git would print it
  origins: Record<string, string>
  dirs: Record<string, string[]>
  posts: { path: string }[]
  matchTo: Record<string, { id: string; name: string }>
}

function world(on: any, start: Partial<World> = {}): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 9, 12, 0) })
  const w: World = {
    clock,
    store: new Map(),
    term: 'Apple_Terminal',
    runs: [],
    launchExit: 0,
    launchThrows: false,
    origins: {
      [CWD]: 'git@github.com:acme/forge.git',
      '/home/ada/code/anvil': 'ssh://git@github.com/acme/anvil.git',
      '/home/ada/HiveOp/lathe': 'https://github.com/Acme/Lathe.git',
      '/elsewhere/kiln-copy': 'git@github.com:acme/kiln',
      '/home/ada/code/notes': 'https://github.com/acme/notes',
    },
    dirs: {
      '/home/ada/code': ['forge', 'anvil', 'notes', 'plain'],
      '/home/ada/HiveOp': ['lathe'],
    },
    posts: [],
    matchTo: { 'github.com/acme/forge': { id: 'w-forge', name: 'Forge' } },
    ...start,
  }
  mock.env(on, { HOME, HIVEOP_API_URL: API, TERM_PROGRAM: w.term })
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name ?? 'hiveop' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-123' }))
  on('session.end', (_: unknown, e: any) => ({ sessionId: e.sessionId }))
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv ?? []
    w.runs.push(argv)
    if (argv[0] === 'git') {
      const dir = argv[1] === '-C' ? argv[2]! : (e.init?.cwd ?? CWD)
      const o = w.origins[dir]
      return o === undefined ? { value: { exitCode: 128, stdout: '', stderr: 'not a repo' } } : { value: { exitCode: 0, stdout: o + '\n', stderr: '' } }
    }
    if (argv[0] === 'hostname') return { value: { exitCode: 0, stdout: 'mac\n', stderr: '' } }
    if (w.launchThrows) throw new Error('no such program')
    return { value: { exitCode: w.launchExit, stdout: '', stderr: '' } }
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
    if (method === 'POST') w.posts.push({ path })
    if (path.startsWith('/me/hive/profile')) return reply(200, { profile: { displayName: 'Ada', walletPubkey: ME } })
    if (path.startsWith('/me/workspaces/match')) {
      const k = normRemote(decodeURIComponent(path.split('remote=')[1] ?? ''))
      const hit = w.matchTo[k]
      return reply(200, { success: true, mine: hit ? [hit] : [], joinable: [] })
    }
    if (path === '/workspaces') return reply(200, { workspaces: WSROWS })
    if (path.startsWith('/me/sync')) return reply(200, { cursor: 'c0', events: [], timedOut: true })
    if (path.endsWith('/work-summary')) return reply(200, { success: true, ready: 0, inProgress: 0, next: null })
    if (/\/adopted-sessions$/.test(path) && method === 'POST') return reply(200, { success: true, agentId: 'ag-1', name: 'Claude Code', resumed: false })
    return reply(404)
  })
  return w
}

const text = async (ui: any) => JSON.stringify(await ui.drawn())
const start = async ($: any, cwd = CWD) => $.session.start({ cwd, surface: 'terminal', isInteractive: true })
const adopts = (w: World) => w.posts.filter((p) => /\/adopted-sessions$/.test(p.path))
const launches = (w: World) => w.runs.filter((a) => a[0] !== 'git' && a[0] !== 'hostname')
async function workspaces($: any, surface: 'terminal' | 'desktop') {
  const pane = await $.ui.mount({ ...PANE, surface })
  if (await pane.find({ key: 'home-workspaces' })) await pane.press({ key: 'home-workspaces' })
  return pane
}

test('the row button follows where the code is; who pays is said once, behind More', async ($, on) => {
  const w = world(on, { store: new Map<string, unknown>([['clones.byRemote', { 'github.com/acme/kiln': '/elsewhere/kiln-copy' }]]) })
  await start($)
  await w.clock.advance(50)
  for (const surface of SURFACES) {
    const pane = await workspaces($, surface)
    const shown = await text(pane)
    expect(await pane.find({ key: 'ws-code-w-forge' })).toBeDefined()
    expect(shown).not.toContain('ws-open-w-forge')
    for (const n of ['anvil', 'lathe', 'kiln']) {
      expect(await pane.find({ key: `ws-open-w-${n}` })).toBeDefined()
      expect(await pane.find({ key: `ws-code-w-${n}` })).toBeUndefined()
    }
    expect(await text(pane)).not.toContain('ws-open-w-press')
    expect(shown).not.toContain('ws-code-w-press')
    expect(shown).not.toContain('your Claude plan')
    await pane.unmount()
  }
})

test('Code here runs Join', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-code-w-forge' })
  expect(adopts(w)).toHaveLength(1)
  expect(adopts(w)[0]!.path).toBe('/workspaces/w-forge/adopted-sessions')
  await pane.unmount()
})

test('a folder that matches a workspace is remembered as remote -> path, and survives a new session', async ($, on) => {
  const w = world(on, { dirs: {}, origins: { '/home/ada/code/forge': 'git@github.com:acme/forge.git' } })
  await start($)
  await w.clock.advance(50)
  expect(w.store.get('clones.byRemote')).toEqual({ 'github.com/acme/forge': CWD })
})

test('a remembered folder is found from another session folder', async ($, on) => {
  const store = new Map<string, unknown>([['clones.byRemote', { 'github.com/acme/forge': CWD }]])
  const w = world(on, { store, dirs: {}, origins: { '/home/ada/code/forge': 'https://github.com/acme/forge' }, matchTo: {} })
  await start($, '/tmp/somewhere')
  await w.clock.advance(50)
  const pane = await workspaces($, 'terminal')
  expect(await pane.find({ key: 'ws-open-w-forge' })).toBeDefined()
  await pane.unmount()
})

test('a remembered folder that is no longer that repo is not offered', async ($, on) => {
  const store = new Map<string, unknown>([['clones.byRemote', { 'github.com/acme/press': '/gone/press' }]])
  const w = world(on, { store, matchTo: {} })
  await start($, '/tmp/somewhere')
  await w.clock.advance(50)
  const pane = await workspaces($, 'terminal')
  expect(await text(pane)).not.toContain('ws-open-w-press')
  await pane.unmount()
})

test('Open launches the terminal in the clone, writes a 2-minute join note, and tells nothing to the model', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-open-w-anvil' })
  const l = launches(w)
  expect(l).toHaveLength(1)
  expect(l[0]![0]).toBe('osascript')
  expect(l[0]!.join(' ')).toContain("cd '/home/ada/code/anvil' && claude")
  const rec = Object.values(w.store.get('join.open') as Record<string, { ws: string; exp: number }>)
  expect(rec).toEqual([{ ws: 'w-anvil', exp: Date.UTC(2026, 10, 9, 12, 0, 0) + 50 + 120_000 }])
  expect(await text(pane)).toContain('Opened Anvil')
  await pane.unmount()
})

test('Open falls back to the copyable command when the launch fails', async ($, on) => {
  const w = world(on, { launchExit: 1 })
  await start($)
  await w.clock.advance(50)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-open-w-anvil' })
  expect(await text(pane)).toContain("cd '/home/ada/code/anvil' && claude")
  await pane.unmount()
})

test('Open falls back to the copyable command when the launch throws', async ($, on) => {
  const w = world(on, { launchThrows: true })
  await start($)
  await w.clock.advance(50)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-open-w-anvil' })
  expect(await text(pane)).toContain("cd '/home/ada/code/anvil' && claude")
  await pane.unmount()
})

test('Open falls back to the copyable command when the terminal is unknown', async ($, on) => {
  const w = world(on, { term: 'xterm-256color' })
  await start($)
  await w.clock.advance(50)
  const pane = await workspaces($, 'terminal')
  await pane.press({ key: 'ws-open-w-anvil' })
  expect(await text(pane)).toContain("cd '/home/ada/code/anvil' && claude")
  await pane.unmount()
})

test('on desktop nothing is launched; the command is shown', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(50)
  const pane = await workspaces($, 'desktop')
  await pane.press({ key: 'ws-open-w-lathe' })
  expect(launches(w)).toHaveLength(0)
  expect(await text(pane)).toContain("cd '/home/ada/HiveOp/lathe' && claude")
  await pane.unmount()
})

test('a fresh join-on-open note joins without a click, and is consumed', async ($, on) => {
  const now = Date.UTC(2026, 10, 9, 12, 0)
  const store = new Map<string, unknown>([['join.open', { ZZ: { ws: 'w-x', exp: now + 1000 } }]])
  const w = world(on, { store })
  // Same folder key as the session folder.
  store.set('join.open', { [folderKey(CWD)]: { ws: 'w-forge', exp: now + 60_000 } })
  await start($)
  await w.clock.advance(50)
  expect(adopts(w)).toHaveLength(1)
  expect((w.store.get('join.open') as Record<string, unknown>)[folderKey(CWD)]).toBeUndefined()
})

test('an expired join-on-open note does not join, and is still removed', async ($, on) => {
  const now = Date.UTC(2026, 10, 9, 12, 0)
  const store = new Map<string, unknown>([['join.open', { [folderKey(CWD)]: { ws: 'w-forge', exp: now - 1 } }]])
  const w = world(on, { store })
  await start($)
  await w.clock.advance(50)
  expect(adopts(w)).toHaveLength(0)
  expect((w.store.get('join.open') as Record<string, unknown>)[folderKey(CWD)]).toBeUndefined()
})

test('remotes normalise across ssh and https', () => {
  const k = 'github.com/acme/forge'
  for (const u of ['git@github.com:acme/forge.git', 'https://github.com/acme/forge', 'https://user@GitHub.com/Acme/Forge.git/', 'ssh://git@github.com:22/acme/forge.git']) {
    expect(normRemote(u)).toBe(k)
  }
  expect(normRemote('')).toBe('')
  expect(normRemote('not a url')).toBe('')
})

test('launch command per terminal; unknown terminal has none', () => {
  const dir = "/home/ada/it's here"
  expect(launchArgv('Apple_Terminal', dir, null)![0]).toBe('osascript')
  expect(launchArgv('iTerm.app', dir, null)!.join(' ')).toContain('iTerm')
  expect(launchArgv('ghostty', '/d', null)).toEqual(['open', '-na', 'Ghostty', '--args', '--working-directory=/d', '-e', 'claude'])
  expect(launchArgv('WezTerm', '/d', '/p')).toEqual(['wezterm', 'cli', 'spawn', '--cwd', '/d', '--', 'claude', '--plugin-dir', '/p'])
  expect(launchArgv('kitty', '/d', null)).toEqual(['kitten', '@', 'launch', '--type=tab', '--cwd', '/d', 'claude'])
  expect(launchArgv('vscode', '/d', null)).toBeNull()
  expect(claudeCommand(dir, null)).toBe("cd '/home/ada/it'\\''s here' && claude")
  expect(claudeCommand('/d', '/p')).toBe("cd '/d' && claude --plugin-dir '/p'")
})

test('--plugin-dir is passed on only when this session was started that way', () => {
  expect(inlinePluginDir('/home/ada/.claude/plugins/cache/hiveop', '/home/ada')).toBeNull()
  expect(inlinePluginDir('/home/ada/hiveop-claude', '/home/ada')).toBe('/home/ada/hiveop-claude')
})
