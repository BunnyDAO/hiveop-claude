/** What the band and the pane draw. Never holds the key. */
export type AuthView =
  | { phase: 'signed-out' }
  | { phase: 'pairing'; code: string; link: string; expiresAt: string }
  | { phase: 'signed-in'; name: string | null }
  // Why sign-in ended without a key.
  | { phase: 'ended'; reason: 'denied' | 'expired' | 'not-open' | 'unreachable' | 'rejected' }

/** One chat line as the pane draws it. */
// `mine`: sent by the signed-in person themselves (not by one of their agents).
export type ChatMsg = { id: string; name: string; text: string; at: number; mine: boolean }

/** The send box under the messages. */
export type SendState =
  | { phase: 'idle' }
  | { phase: 'failed'; text: string }
  | { phase: 'limited'; seconds: number; text: string }

/** The chat room the person sees. Messages are other people's words: never in command output. */
export type ChatView = {
  workspace: { id: string; name: string } | null
  status: 'loading' | 'ready' | 'offline' | 'no-workspace'
  screen: 'home' | 'chat'
  messages: ChatMsg[]
  unread: number
  // The first message that arrived while the room was not in view.
  firstNewId: string | null
  draft: string
  // The signed-in person's wallet (account identity), for telling their own lines.
  me: string | null
  send: SendState
}

declare module 'claude-code' {
  interface PluginState {
    hiveop: { auth: Shaped<AuthView>; chat: Shaped<ChatView> }
  }
}
