/** What the band and the pane draw. Never holds the key. */
export type AuthView =
  | { phase: 'signed-out' }
  | { phase: 'pairing'; code: string; link: string; expiresAt: string }
  | { phase: 'signed-in'; name: string | null }
  // Why sign-in ended without a key.
  | { phase: 'ended'; reason: 'denied' | 'expired' | 'not-open' | 'unreachable' | 'rejected' }

/** One chat line as the pane draws it. */
// `mine`: sent by the signed-in person themselves (not by one of their agents).
// `who`: the run key (same person = same value; agents are their own). `photo`: the wallet whose photo to fetch, '' for none.
// `color`: the person's HiveOp colour when the server sent one, else null (brand cyan).
export type ChatMsg = { id: string; name: string; text: string; at: number; mine: boolean; who: string; photo: string; color: string | null }

/** Profile photos by wallet (hcp-21): base64 PNG bytes, or none. Other people's pictures: pane only. */
export type PhotosView = { byWallet: Record<string, { state: 'loading' | 'ok' | 'none'; png: string | null }> }

/** The send box under the messages. */
export type SendState =
  | { phase: 'idle' }
  | { phase: 'failed'; text: string }
  | { phase: 'limited'; seconds: number; text: string }

/** The chat room the person sees. Messages are other people's words: never in command output. */
export type ChatTab = { id: string; name: string; unread: number }

export type ChatView = {
  // The room being viewed: one of the open tabs.
  workspace: { id: string; name: string } | null
  // Open chat rooms, one tab each. `unread` counts rooms out of view; the viewed room counts in `unread` below.
  tabs: ChatTab[]
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
  mine: WsRow[] | null
  invites: InviteRow[] | null
  explore: { search: string; rows: WsRow[]; offset: number; total: number; loaded: boolean }
  people: { query: string; rows: PilotRow[]; following: string[]; offset: number; more: boolean; loaded: boolean }
}

/** The work band: the seat workspace's ready queue. Titles are other people's words: band, pane and toasts only. */
export type WorkView = {
  workspaceId: string | null
  loaded: boolean
  ready: number
  inProgress: number
  next: { id: string; title: string } | null
  // One plain line after Claim: what happened, or the server's own reason.
  note: string
  claiming: boolean
}

/**
 * This window's seat (hcp-15): what the folder points at, and the agent the person joined as.
 * The prompt gets only the seat facts, never anything from chat.
 */
export type SeatView = {
  // What the folder's git remote says: unchecked, no workspace, one of mine, or one I am not in.
  folder: 'unchecked' | 'none' | 'mine' | 'joinable'
  target: { id: string; name: string } | null
  // Join automatically in matching folders (the person's choice, kept across sessions).
  auto: boolean
  seat: { workspaceId: string; workspaceName: string; agentId: string; name: string; claimed: string | null } | null
  busy: boolean
  // One plain line: what just happened, or why the server said no.
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    hiveop: { auth: Shaped<AuthView>; chat: Shaped<ChatView>; nav: Shaped<NavView>; work: Shaped<WorkView>; seat: Shaped<SeatView>; photos: Shaped<PhotosView> }
  }
}
