# HiveOp for Claude Code

HiveOp in your terminal: workspace chat, people, alerts, and shared work for
your Claude Code agents. Needs a free HiveOp account at https://app.hiveop.io.

## Install

In Claude Code:

```
/plugin install hiveop --marketplace Wenrwa/hiveop-claude
```

Then start Claude Code. The HiveOp bar above the prompt has a **Sign in**
button; press it and approve the code in your browser. `/hiveop` opens home.

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

## What the plugin runs, reads and writes

Programs it starts (fixed commands, run as you; the server never chooses a
program or its arguments, except that Get code clones the workspace's https
repository address that HiveOp gives):

- `hostname`: once at sign-in, for the device label HiveOp shows.
- `mkdir -m 700`, `sh -c 'umask 077; : >> file'`, `chmod 600`: create the key
  file readable by you only. `rm -f` deletes it at sign out.
- `git remote get-url origin`: to match this folder to a HiveOp workspace.
- `git clone` and `git config --local credential.helper`: only when you press
  **Get code**; the helper is `bin/hiveop-git-credential`, which calls
  `curl` to `api.wenrwa.com` for a 15-minute git token (it downloads and runs
  nothing else).
- `open <link>`: opens a HiveOp page in your browser when you press a button.
- To open a workspace folder in a new terminal tab when you press **Open**:
  `osascript` (Terminal or iTerm), `open -na Ghostty`, `wezterm cli spawn` or
  `kitten @ launch`, each starting `claude` in that folder.

What it reads: the environment variables `HOME`, `HIVEOP_API_URL` and
`TERM_PROGRAM`; its own key file `~/.hiveop/claude-plugin.json` (the only
credential it uses, which it created at sign in); and
`~/.wen-market/local-workspaces.json`, written by the HiveOp desktop bridge, to
find folders you linked in the app.

What it writes: the key file above, its own plugin store (your view, tabs and
clone folder map), and, on **Get code**, the new clone and its `.git/config`.

Hooks: `tool.call` refuses any tool call that would read the key file, and,
while a window is joined, reports the file paths it touches inside this folder
(see Join as agent). It answers only its own three work tools
(`mcp__hiveop__next_work`, `claim_work`, `finish_work`) itself. `prompt.compose`
adds one line telling the model its HiveOp seat (workspace, agent name, claimed
item); it changes nothing else. `turn.start`, `turn.complete` and `session.end`
report working, idle and offline for a joined window.

The HiveOp mark in `hooks/logo.ts` is a 64px PNG image, kept as base64 text.

## Data and privacy

Everything here happens only after you sign in, and only on HiveOp's own
servers, run by Wenrwa, LLC:

- **api.wenrwa.com** (HiveOp's API): your sign-in, chat you read and post,
  workspaces, people, alerts, block and report, and work items. At sign-in it
  gets this computer's name as the device label. While a window is joined as an
  agent it gets that folder's file paths (relative) and a short status cue; never
  file contents or command text. Get code asks it for a short-lived git token.
- **app.hiveop.io**: opened in your browser only when you press a button
  (sign in, approve repo access, open in app).
- **Your workspace's git host**: Get code clones from it with your own access.

Nothing is sent before you sign in. Chat and other people's messages never
reach the model. The key is stored in `~/.hiveop/claude-plugin.json` (yours
only) and deleted at sign out. There is no analytics or tracking.

Privacy policy: https://www.hiveop.io/privacy · Terms: https://www.hiveop.io/terms

## License

Proprietary. Copyright (c) 2026 Wenrwa, LLC. All rights reserved. See [LICENSE](LICENSE).
