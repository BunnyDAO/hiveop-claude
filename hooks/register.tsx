import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { AuthView } from '../types'
import { computerName, fetchMe, forgetKey, loadKey, pollPairing, saveKey, startPairing } from './client'

const PANE = 'hiveop'
const POLL_MS = 3000
const MAX_POLL_FAILURES = 5

// Change the tag when AuthView changes: an older stored shape reads as signed out.
const auth = atom({ plugin: 'hiveop', key: 'auth' } as const, { phase: 'signed-out' } as AuthView, { shape: 'auth-1' })

type Cancel = { cancel: () => void }
// Module variables start over on a reload; session.start resets the view to match.
type Mem = { timer: Cancel | null; pollToken: string | null; failures: number; expiresAtMs: number }

const ENDED_TEXT: Record<Extract<AuthView, { phase: 'ended' }>['reason'], string> = {
  denied: 'Sign-in was denied.',
  expired: 'The code expired.',
  'not-open': "HiveOp for Claude Code isn't open yet.",
  unreachable: "Couldn't reach HiveOp.",
  rejected: 'HiveOp no longer accepts this sign-in.',
}

function stopPolling(mem: Mem) {
  mem.timer?.cancel()
  mem.timer = null
  mem.pollToken = null
  mem.failures = 0
}

async function finishSignedIn($: Engine) {
  const me = await fetchMe($)
  if (me.state === 'rejected') {
    await forgetKey($)
    await update($, auth, () => ({ phase: 'ended', reason: 'rejected' }) as AuthView)
    return
  }
  await update($, auth, () => ({ phase: 'signed-in', name: me.state === 'ok' ? me.name : null }) as AuthView)
}

async function tick($: Engine, mem: Mem) {
  const token = mem.pollToken
  if (!token) return
  if ((await $.clock.now()) >= mem.expiresAtMs) {
    stopPolling(mem)
    await update($, auth, () => ({ phase: 'ended', reason: 'expired' }) as AuthView)
    return
  }
  const r = await pollPairing($, token)
  if (mem.pollToken !== token) return // cancelled while the request was out
  if (r.status === 'pending') {
    mem.failures = 0
    return
  }
  if (r.status === 'unreachable') {
    mem.failures += 1
    if (mem.failures >= MAX_POLL_FAILURES) {
      stopPolling(mem)
      await update($, auth, () => ({ phase: 'ended', reason: 'unreachable' }) as AuthView)
    }
    return
  }
  stopPolling(mem)
  if (r.status === 'approved') {
    if (!(await saveKey($, r.key))) {
      await update($, auth, () => ({ phase: 'ended', reason: 'unreachable' }) as AuthView)
      return
    }
    await finishSignedIn($)
    $.ui.toast('HiveOp · signed in')
    return
  }
  const reason = r.status === 'denied' ? r.reason : 'expired'
  await update($, auth, () => ({ phase: 'ended', reason }) as AuthView)
}

async function signIn($: Engine, mem: Mem): Promise<AuthView> {
  stopPolling(mem)
  const pairing = await startPairing($, await computerName($))
  if (!pairing) {
    const view: AuthView = { phase: 'ended', reason: 'unreachable' }
    await update($, auth, () => view)
    return view
  }
  const view: AuthView = { phase: 'pairing', code: pairing.code, link: pairing.link, expiresAt: pairing.expiresAt }
  mem.pollToken = pairing.pollToken
  mem.expiresAtMs = Date.parse(pairing.expiresAt) || (await $.clock.now()) + 10 * 60_000
  await update($, auth, () => view)
  mem.timer = $.clock.every(POLL_MS, () => {
    void tick($, mem)
  })
  return view
}

async function signOut($: Engine, mem: Mem) {
  stopPolling(mem)
  await forgetKey($)
  await update($, auth, () => ({ phase: 'signed-out' }) as AuthView)
}

async function restore($: Engine, mem: Mem) {
  stopPolling(mem)
  if (await loadKey($)) {
    await update($, auth, () => ({ phase: 'signed-in', name: null }) as AuthView)
    await finishSignedIn($)
  } else {
    await update($, auth, () => ({ phase: 'signed-out' }) as AuthView)
  }
}

function bandText(v: AuthView): string {
  switch (v.phase) {
    case 'signed-out':
      return ' · Sign in'
    case 'pairing':
      return ` · code ${v.code} · approve at app.hiveop.io/claude-code`
    case 'signed-in':
      return ` · ${v.name ?? 'you'}`
    case 'ended':
      return ` · ${ENDED_TEXT[v.reason]}`
  }
}

// HiveOp brand cyan (app.hiveop.io accent).
const BRAND = '#22D3EE'

export const register: Register = (on) => {
  const mem: Mem = { timer: null, pollToken: null, failures: 0, expiresAtMs: 0 }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hiveop', description: 'HiveOp: sign in, and your account in Claude Code' })
    await restore($, mem)
    return next(e)
  })

  on('command.run', { command: 'hiveop' }, async ($, e) => {
    let view = await read($, auth)
    const sub = (e.args ?? '').trim().toLowerCase()
    if (sub === 'sign-out' || sub === 'signout') {
      await signOut($, mem)
      return { text: 'Signed out of HiveOp on this computer.' }
    }
    if (view.phase !== 'signed-in' && view.phase !== 'pairing') view = await signInIfAsked($, mem, view, sub)

    const opened = await $.ui.open({ id: PANE, title: 'HiveOp' })
    if (opened.isPlaced) return { text: 'HiveOp opened.' }
    // Too narrow for a pane: a short pick-list, then plain words.
    return { text: await narrow($, mem, view) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, auth)
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text wrap="truncate-end">
          <Text color={BRAND} bold>HiveOp</Text>
          {bandText(v)}
        </Text>
        {(v.phase === 'signed-out' || v.phase === 'ended') && (
          <Button key="band-sign-in" label=" Sign in" onPress={() => void signIn($, mem)} />
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await read($, auth)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text bold color={BRAND}>HiveOp</Text>
        {v.phase === 'signed-out' && (
          <Box flexDirection="column">
            <Text>Sign in with your HiveOp account.</Text>
            <Button key="sign-in" label="Sign in" variant="primary" onPress={() => void signIn($, mem)} />
          </Box>
        )}
        {v.phase === 'pairing' && (
          <Box flexDirection="column">
            <Text>Code <Text bold color={BRAND}>{v.code}</Text></Text>
            <Text>Approve it at</Text>
            <Text color={BRAND}>{v.link}</Text>
            <Button key="cancel" label="Cancel" onPress={() => void signOut($, mem)} />
          </Box>
        )}
        {v.phase === 'signed-in' && (
          <Box flexDirection="column">
            <Text>Signed in as <Text bold color={BRAND}>{v.name ?? 'you'}</Text></Text>
            <Button key="sign-out" label="Sign out" onPress={() => void signOut($, mem)} />
          </Box>
        )}
        {v.phase === 'ended' && (
          <Box flexDirection="column">
            <Text color="yellow">{ENDED_TEXT[v.reason]}</Text>
            {v.reason !== 'not-open' && <Button key="retry" label="Sign in" variant="primary" onPress={() => void signIn($, mem)} />}
          </Box>
        )}
      </Box>
    )
  })
}

async function signInIfAsked($: Engine, mem: Mem, view: AuthView, sub: string): Promise<AuthView> {
  // `/hiveop` alone only opens the home; `/hiveop sign-in` starts a code.
  if (sub === 'sign-in' || sub === 'signin') return signIn($, mem)
  return view
}

async function narrow($: Engine, mem: Mem, view: AuthView): Promise<string> {
  if (view.phase === 'pairing') return `HiveOp code ${view.code}. Approve at ${view.link}`
  if (view.phase === 'signed-in') {
    const pick = await $.ui.ask(`HiveOp · ${view.name ?? 'signed in'}`, ['Sign out', 'Close']).catch(() => 'Close')
    if (pick === 'Sign out') {
      await signOut($, mem)
      return 'Signed out of HiveOp on this computer.'
    }
    return `HiveOp · ${view.name ?? 'signed in'}`
  }
  const pick = await $.ui.ask(view.phase === 'ended' ? ENDED_TEXT[view.reason] + ' Sign in?' : 'HiveOp: sign in?', ['Sign in', 'Not now']).catch(
    () => 'Not now',
  )
  if (pick !== 'Sign in') return 'HiveOp: not signed in.'
  const v = await signIn($, mem)
  return v.phase === 'pairing' ? `HiveOp code ${v.code}. Approve at ${v.link}` : ENDED_TEXT[v.phase === 'ended' ? v.reason : 'unreachable']
}
