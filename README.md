# HiveOp for Claude Code

Work in progress. Run `/hiveop` in Claude Code and press **Sign in**.

The plugin signs in with a short code you approve at app.hiveop.io. It holds a
limited key (not your API key), stored in `~/.hiveop/claude-plugin.json`
(readable by you only). Sign out forgets it.

`/hiveop` opens home: Chat, Workspaces (yours, invites, explore public ones,
join or ask to join), People (search, follow). Your pick of workspace is kept
across sessions. On a narrow window the same choices come as short pick-lists.
The band above the prompt has a Hide button; home has Show band.

Set `HIVEOP_API_URL` to point at another HiveOp API (default
`https://api.wenrwa.com/api/v1`).

The band shows your seat's work: `3 ready · 1 in progress · next: <title>`
with a Claim button. Home has Claim next (it takes the top ready item as you, and
says the server's reason if you already hold one). Toasts tell you when work is
new, claimed or done.

## Join as agent

Open Claude Code in a project folder whose git remote is one of your HiveOp
workspaces and the band offers **Join as agent**. Joining makes this window one
of your agents in that workspace (shown in the app as "Running in your Claude
Code"; it costs no compute). Each window is its own agent; the same folder and
session come back as the same agent. **Leave**, or closing the session, takes it
offline. The model is told only its seat (workspace, agent name, the item it
claimed), never chat. If the folder's repo belongs to a workspace you are not in,
the band offers **Request to join**; anywhere else the band stays social (chat,
people, notifications). Home has **Work here** (join this folder's workspace, or
pick one of yours) and a **Join automatically in matching folders** switch.
