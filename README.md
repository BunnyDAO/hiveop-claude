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
