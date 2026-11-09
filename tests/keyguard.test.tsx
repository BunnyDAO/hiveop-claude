import { expect, test } from 'claude-code/testing'

const HOME = '/home/ada'
const REFUSAL = 'HiveOp blocks reading its sign-in key.'

// Underneath the guard: every tool "works", so only the guard can refuse.
function world(on: any, surface: 'terminal' = 'terminal') {
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('tool.call', (_: unknown, e: any) => ({ result: 'ran', text: 'ran' }))
  return surface
}

async function run($: any, input: Record<string, unknown>) {
  return $.tool.call(input)
}

const BLOCKED_BASH = [
  'cat ~/.hiveop/claude-plugin.json',
  'cat $HOME/.hiveop/claude-plugin.json',
  'cat ${HOME}/.hiveop/claude-plugin.json',
  'cat "$HOME/.hiveop/claude-plugin.json"',
  "cat '/home/ada/.hiveop/claude-plugin.json'",
  'cat /home/ada/.hiveop/claude-plugin.json',
  'grep key ~/.hiveop/claude-plugin.json',
  'less ~/.hiveop/claude-plugin.json',
  'cp ~/.hiveop/claude-plugin.json /tmp/x',
  'base64 ~/.hiveop/claude-plugin.json',
  'python3 -c "print(open(\'/home/ada/.hiveop/claude-plugin.json\').read())"',
  'node -e "console.log(require(\'fs\').readFileSync(process.env.HOME+\'/.hiveop/claude-plugin.json\'))"',
  'cat ~/.hive*/claude-plugin.json',
  'cat ~/.h*op/claude-*',
  'cat ~/.hiv"eop"/claude-plugin.json',
  'cat ~/.hi\\veop/claude-plugin.json',
  'cat ~//.hiveop/./claude-plugin.json',
  'ls ~/.hiveop',
  'cd ~/.hiveop && cat claude-plugin.json',
  'cd ~/.hiveop; tar c .',
  'cat .hiveop/claude-plugin.json',
  'sh -c "cat claude-plugin.json"',
  '~/plugins/hiveop/bin/hiveop-git-credential https://api.x/api/v1 ws-1 get',
  'sh /x/bin/hiveop-git-credential https://a ws get',
  'printf "protocol=https\\nhost=git.hiveop.io\\n\\n" | git credential fill',
  'git credential fill < /tmp/req',
  'echo ok && git credential fill',
]
const PASSES_BASH = [
  'git push',
  'git push origin main',
  'git pull --rebase',
  'git clone https://git.hiveop.io/acme/forge.git',
  'git config --get credential.helper',
  'git credential-osxkeychain --help',
  'ls -la',
  'cat README.md',
  'cat .hiveop/notes.md',
  'ls ~/.config',
  'cat ~/.zshrc',
  'grep -rn hiveop README.md',
  'cat package.json *.json',
  'npm test',
]
test('Bash that reads or leaks the key is refused with one line', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  for (const command of BLOCKED_BASH) {
    const r = await run($, { tool: 'Bash', command })
    expect({ command, deny: r.deny }).toEqual({ command, deny: REFUSAL })
  }
})

test('ordinary Bash, git push and git pull pass', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  for (const command of PASSES_BASH) {
    const r = await run($, { tool: 'Bash', command })
    expect({ command, deny: r.deny }).toEqual({ command, deny: undefined })
  }
})

test('file tools on the key folder are refused, however the path is spelled', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const blocked: Record<string, unknown>[] = [
    { tool: 'Read', file_path: '/home/ada/.hiveop/claude-plugin.json' },
    { tool: 'Read', file_path: '~/.hiveop/claude-plugin.json' },
    { tool: 'Read', file_path: '$HOME/.hiveop/claude-plugin.json' },
    { tool: 'Read', file_path: '/home/ada/x/../.hiveop/claude-plugin.json' },
    { tool: 'Read', file_path: '/home/ada/.hiveop' },
    { tool: 'Edit', file_path: '/home/ada/.hiveop/claude-plugin.json', old_string: 'a', new_string: 'b' },
    { tool: 'Write', file_path: '/home/ada/.hiveop/claude-plugin.json', content: 'x' },
    { tool: 'NotebookEdit', notebook_path: '/home/ada/.hiveop/k.ipynb', new_source: 'x' },
    { tool: 'Grep', pattern: 'wm_', path: '/home/ada/.hiveop' },
    { tool: 'Grep', pattern: 'wm_', path: '~/.hiveop/claude-plugin.json' },
    { tool: 'Grep', pattern: 'wm_', path: '/home/ada', glob: '.hiveop/*' },
    { tool: 'Glob', pattern: '*', path: '/home/ada/.hiveop' },
    { tool: 'Glob', pattern: '/home/ada/.hive*/*' },
    { tool: 'Glob', pattern: '**/claude-plugin.json', path: '/home/ada' },
  ]
  for (const input of blocked) {
    const r = await run($, input)
    expect({ input, deny: r.deny }).toEqual({ input, deny: REFUSAL })
  }
})

test('file tools elsewhere pass, including a project .hiveop folder and a search that merely names it', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ok: Record<string, unknown>[] = [
    { tool: 'Read', file_path: '/work/README.md' },
    { tool: 'Read', file_path: '/work/.hiveop/notes.md' },
    { tool: 'Read', file_path: '/home/ada/.zshrc' },
    { tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' },
    { tool: 'Write', file_path: '/work/b.ts', content: 'x' },
    { tool: 'Grep', pattern: '.hiveop', path: '/work' },
    { tool: 'Glob', pattern: '**/*.ts', path: '/work' },
  ]
  for (const input of ok) {
    const r = await run($, input)
    expect({ input, deny: r.deny }).toEqual({ input, deny: undefined })
  }
})
