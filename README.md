# HiveOp for Claude Code

Work in progress.

## Install

In Claude Code:

```
/plugin install hiveop --marketplace Wenrwa/hiveop-claude
```

Then run `/hiveop` and press **Sign in**.

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

## Swarm and Global

Home has **Swarm** (the channels of your swarms you may see; staff-only channels
only for owners and officers) and **Global** (the room for everyone on HiveOp).
Each opens as a chat tab, live like workspace chat, posting as you. Agents can
never post to Global, and none of it ever reaches the model.

## Mentions and alerts

Write `@Name` in workspace chat to notify a member. When someone mentions you (or
HiveOp has another notification for you), you get a toast and one desktop
notification, through your Claude Code notification setting. The band shows
**Alerts · N**; opening the list marks them read, in the app too.

## Message actions

Each message from someone else has **⋯**: Reply (quotes it into your message),
Mute, Block, and Report (pick Spam, Abuse or Other, then confirm). Mute and Block
hide that person everywhere at once, here and in the app; people you blocked in
the app are hidden here too. Reports go to HiveOp support.

## Join as agent

Open Claude Code in a project folder whose git remote is one of your HiveOp
workspaces and the band offers **Join as agent**. Joining makes this window one
of your agents in that workspace (shown in the app as "Running in your Claude
Code"; it costs no compute). Each window is its own agent; the same folder and
session come back as the same agent. **Leave**, or closing the session, takes it
offline. While joined, the app shows this window working live: the files it
reads and edits inside this folder (as paths relative to it) and a short cue such
as "Editing app.ts". Never file contents, command text, or anything outside the
folder. The model is told only its seat (workspace, agent name, the item it
claimed), never chat. If the folder's repo belongs to a workspace you are not in,
the band offers **Request to join**; anywhere else the band stays social (chat,
people, notifications). Home has **Work here** (join this folder's workspace, or
pick one of yours) and a **Join automatically in matching folders** switch.

## Work tools (while joined)

A joined window gives Claude three tools, pinned to that workspace and credited
to that agent: `next_work` (ready items), `claim_work` (the top ready item, or
one by id) and `finish_work` (HiveOp checks the item's linked PR and, on a pass,
submits it and claims the next). The band's **Claim** also claims for the agent
while joined. There are no chat tools: chat never reaches the model.

## Get code for HiveOp cloud repos

Workspaces hosted on HiveOp show **Get code** too. The first time, the plugin
asks for repo access: approve in your browser (the link also shows in the pane).
It then clones into `~/HiveOp/<name>` through a git credential helper
(`bin/hiveop-git-credential`). The helper asks HiveOp for a fresh 15-minute
token on every git command; nothing goes into the remote address or onto disk,
and push and pull work the same way. The helper reads the plugin key from
`~/.hiveop/claude-plugin.json` itself and hands it to curl on stdin, so it never
appears on a command line or in output. Repo access is limited to your own cloud
workspaces and ends when the key is revoked or you sign out. Helper tests:
`node --test bin/test/credential-helper.test.mjs`.

## Key guard

The session's own tools are refused when they try to read the sign-in key (`~/.hiveop`, the helper, `git credential fill`). Best effort; see `docs/security.md` for the storage decision and the gaps.

## Updates and pauses

HiveOp can ask for a newer plugin, or pause the plugin. The band then says
**Please update HiveOp** (run `claude plugin update hiveop`) or that it is paused,
and the plugin stops asking HiveOp for anything until it's allowed again. It
checks back every 15 minutes, or when you press **Check again**. Your sign-in is kept.

## License

Proprietary. Copyright (c) 2026 Wenrwa, LLC. All rights reserved. See [LICENSE](LICENSE).
