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

/** One workspace as a list row. */
export type WsRow = { id: string; name: string; kind: string; members: number | null; canJoin: boolean }
/** A pending invite to the signed-in person. The token only ever goes back to the server. */
export type InviteRow = { id: string; token: string; wsId: string; wsName: string }
export type PilotRow = { wallet: string; name: string }

/** Home, workspaces and people: what the pane draws besides the chat. Names here are other people's: pane only. */
export type NavView = {
  screen: 'home' | 'workspaces' | 'people'
  tab: 'mine' | 'invites' | 'explore'
  // The band above the prompt: person's choice, kept across sessions.
  band: 'shown' | 'hidden'
  // One plain line: what just happened, or why the server said no.
  note: string
  // The workspace chat and the band follow: its id.
  current: string | null
  mine: WsRow[] | null
  invites: InviteRow[] | null
  explore: { search: string; rows: WsRow[]; offset: number; total: number; loaded: boolean }
  people: { query: string; rows: PilotRow[]; following: string[]; offset: number; more: boolean; loaded: boolean }
}

declare module 'claude-code' {
  interface PluginState {
    hiveop: { auth: Shaped<AuthView>; chat: Shaped<ChatView>; nav: Shaped<NavView> }
  }
}
