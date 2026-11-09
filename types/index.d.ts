/** What the band and the pane draw. Never holds the key. */
export type AuthView =
  | { phase: 'signed-out' }
  | { phase: 'pairing'; code: string; link: string; expiresAt: string }
  | { phase: 'signed-in'; name: string | null }
  // Why sign-in ended without a key.
  | { phase: 'ended'; reason: 'denied' | 'expired' | 'not-open' | 'unreachable' | 'rejected' }

declare module 'claude-code' {
  interface PluginState {
    hiveop: { auth: Shaped<AuthView> }
  }
}
