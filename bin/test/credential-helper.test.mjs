// hcp-26: the git credential helper, run for real with a stand-in `curl`. No network.
// Run: node --test bin/test/   (the plugin runner only loads hooks modules, so this lives apart)
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY = 'wm_ct_SECRETKEYSECRETKEY'
const TOKEN = 'abc123def456'
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'hiveop-git-credential')
const API = 'https://api.test/api/v1'
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function run(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hcp26-'))
  const home = join(dir, 'home')
  mkdirSync(join(home, '.hiveop'), { recursive: true })
  if (opts.key !== null) writeFileSync(join(home, '.hiveop', 'claude-plugin.json'), JSON.stringify({ key: opts.key ?? KEY }))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const status = opts.status ?? 200
  const body = opts.body ?? JSON.stringify({ success: true, username: 'x-access-token', token: TOKEN, expiresAt: '2026-11-09T12:15:00.000Z' })
  // The stand-in curl records its argv and stdin, then answers like `-w '\n%{http_code}'`.
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\n${opts.curlFails ? 'exit 7' : `printf '%s\\n%s' '${body}' '${status}'`}\n`)
  chmodSync(join(bin, 'curl'), 0o755)
  const r = spawnSync('sh', [SCRIPT, API, WS, opts.verb ?? 'get'], {
    input: 'protocol=https\nhost=git.test\n\n',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
    encoding: 'utf8',
  })
  const read = (f) => {
    try {
      return readFileSync(join(dir, f), 'utf8')
    } catch {
      return ''
    }
  }
  return { code: r.status, out: r.stdout, err: r.stderr, argv: read('argv'), stdin: read('stdin') }
}

test('get answers git with username and a fresh token, nothing else', () => {
  const r = run()
  assert.equal(r.code, 0)
  assert.equal(r.out, `username=x-access-token\npassword=${TOKEN}\n`)
  assert.equal(r.err, '')
})

test('the key rides on curl stdin, never on a command line or in output', () => {
  const r = run()
  assert.ok(!r.argv.includes(KEY))
  assert.ok(!r.argv.includes('Bearer'))
  assert.ok(r.stdin.includes(`Authorization: Bearer ${KEY}`))
  assert.ok(r.stdin.includes(`${API}/workspaces/${WS}/repo-credential`))
  assert.ok(!(r.out + r.err).includes(KEY))
})

test('store and erase do nothing and call nothing', () => {
  for (const verb of ['store', 'erase']) {
    const r = run({ verb })
    assert.equal(r.code, 0)
    assert.equal(r.out, '')
    assert.equal(r.argv, '')
  }
})

test('a revoked key or grant is the one word revoked', () => {
  assert.equal(run({ status: 401, body: '{}' }).err, 'hiveop-git-credential: revoked\n')
  const g = run({ status: 403, body: '{"error":{"code":"REPO_ACCESS_NOT_GRANTED"}}' })
  assert.equal(g.err, 'hiveop-git-credential: revoked\n')
  assert.equal(g.code, 1)
  assert.equal(g.out, '')
})

test('other refusals and outages fail with fixed words only', () => {
  assert.equal(run({ status: 403, body: '{"error":{"code":"X","message":"nope"}}' }).err, 'hiveop-git-credential: refused\n')
  assert.equal(run({ status: 500, body: '{}' }).err, 'hiveop-git-credential: unavailable\n')
  assert.equal(run({ curlFails: true }).err, 'hiveop-git-credential: unavailable\n')
})

test('no key file, or a malformed key, never calls the API', () => {
  const a = run({ key: null })
  assert.equal(a.err, 'hiveop-git-credential: not signed in\n')
  assert.equal(a.argv, '')
  const b = run({ key: 'bad key"; rm -rf /' })
  assert.equal(b.err, 'hiveop-git-credential: not signed in\n')
  assert.equal(b.argv, '')
})

test('a token with odd characters is refused, not passed to git', () => {
  const r = run({ body: JSON.stringify({ username: 'u', token: 'a b\\nc' }) })
  assert.equal(r.out, '')
  assert.equal(r.code, 1)
})
