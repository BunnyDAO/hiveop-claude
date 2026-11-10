/** What the band and the pane draw. Never holds the key. */
export type AuthView =
  | { phase: 'signed-out' }
  | { phase: 'pairing'; code: string; link: string; expiresAt: string }
  | { phase: 'signed-in'; name: string | null }
  // Why sign-in ended without a key.
  | { phase: 'ended'; reason: 'denied' | 'expired' | 'not-open' | 'unreachable' | 'rejected' }
  // hcp-02: HiveOp's client gate says this version is too old, or the plugin is paused. The key is kept.
  | { phase: 'gated'; why: 'update' | 'paused'; message: string | null }

/** One chat line as the pane draws it. */
// `mine`: sent by the signed-in person themselves (not by one of their agents).
// `who`: the run key (same person = same value; agents are their own). `photo`: the wallet whose photo to fetch, '' for none.
// `color`: the person's HiveOp colour when the server sent one, else null (brand cyan).
export type ChatMsg = { id: string; name: string; text: string; at: number; mine: boolean; who: string; photo: string; color: string | null; wallet?: string }

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
  // hcp-08: the message whose actions are open, and how far (menu → report reason → confirm).
  act?: { id: string; step: 'menu' | 'report' | 'confirm'; reason?: 'spam' | 'abuse' | 'other' } | null
  // hcp-18: who else is online in the viewed room (names). Pane only.
  online?: { wsId: string; names: string[] } | null
}

/** One workspace as a list row. */
export type WsRow = { id: string; name: string; kind: string; members: number | null; canJoin: boolean; repoUrl: string }
/** A pending invite to the signed-in person. The token only ever goes back to the server. */
export type InviteRow = { id: string; token: string; wsId: string; wsName: string }
export type PilotRow = { wallet: string; name: string }

/** Home, workspaces and people: what the pane draws besides the chat. Names here are other people's: pane only. */
export type NavView = {
  screen: 'home' | 'workspaces' | 'people' | 'alerts' | 'swarm'
  tab: 'mine' | 'invites' | 'explore'
  // The band above the prompt: person's choice, kept across sessions.
  band: 'shown' | 'hidden'
  // One plain line: what just happened, or why the server said no.
  note: string
  mine: WsRow[] | null
  invites: InviteRow[] | null
  explore: { search: string; rows: WsRow[]; offset: number; total: number; loaded: boolean }
  people: { query: string; rows: PilotRow[]; following: string[]; offset: number; more: boolean; loaded: boolean }
  // The one workspace row opened with More (its actions and cloud agents). Pane only.
  open?: string | null
  // Clones on this computer (hcp-22): normalised git remote → folder. Pane only.
  clones: Record<string, string>
  // hcp-07: the person's swarm channels they may see, once opened. Pane only.
  swarm?: { rows: Array<{ swarmId: string; swarmName: string; channelId: string; name: string }> | null }
  // hcp-09: notifications (mentions and the rest): unread count, and the list once opened. Pane, band and toasts only.
  alerts?: { count: number; rows: AlertRow[] | null }
}

/** One notification as the pane lists it. Other people's words: never in command output. */
export type AlertRow = { id: string; title: string; body: string; at: number }

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

/** One of the person's own cloud agents. Pane only. */
export type CloudAgent = { id: string; name: string; state: string; creditsPerHour: number }

/**
 * Cloud agents by workspace (hcp-25), the one open approval request, and one plain line.
 * `request`: filed, waiting for the browser; `note`: Not approved. / Request expired. / the server's words.
 */
export type CloudView = {
  byWs: Record<string, CloudAgent[]>
  request: { wsId: string; id: string; url: string } | null
  note: { wsId: string; text: string } | null
}

declare module 'claude-code' {
  interface PluginState {
    hiveop: { auth: Shaped<AuthView>; chat: Shaped<ChatView>; nav: Shaped<NavView>; work: Shaped<WorkView>; seat: Shaped<SeatView>; photos: Shaped<PhotosView>; cloud: Shaped<CloudView> }
  }
}
