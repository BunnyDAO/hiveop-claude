// hcp-16: what an adopted session tells HiveOp about its own work, so the app's agent
// card and 3D scene show it live: the files a tool touched (relative to this folder;
// anything outside is dropped) and a short cue ("Editing app.ts"). Never a command's
// text, a file's content, or a path outside the folder.

export type ToolActivity = { filePaths: string[]; thinking: string }

const VERB: Record<string, string> = {
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Write: 'Writing',
  NotebookEdit: 'Editing',
  Read: 'Reading',
  Grep: 'Searching',
  Glob: 'Searching',
}

const MAX_PATHS = 20

/** A path inside `cwd`, relative to it; null when outside or not a path. */
export function insideFolder(p: unknown, cwd: string): string | null {
  if (typeof p !== 'string' || !p || !cwd) return null
  const root = cwd.replace(/\/+$/, '')
  if (!p.startsWith('/')) return p.includes('..') ? null : p.replace(/^\.\//, '')
  if (p !== root && !p.startsWith(`${root}/`)) return null
  const rel = p.slice(root.length + 1)
  return rel && !rel.split('/').includes('..') ? rel : null
}

function base(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

/** The activity one tool call reports, or null for a tool that says nothing worth showing. */
export function activityOf(e: Record<string, unknown>, cwd: string): ToolActivity | null {
  const tool = String(e.tool ?? '')
  if (tool === 'Bash') return { filePaths: [], thinking: 'Running a command' }
  const verb = VERB[tool]
  if (!verb) return tool && !tool.startsWith('mcp__') ? { filePaths: [], thinking: 'Working' } : null
  const raw = e.file_path ?? e.notebook_path ?? e.path
  const rel = insideFolder(raw, cwd)
  if (!rel) return { filePaths: [], thinking: verb === 'Searching' ? 'Searching' : `${verb} a file` }
  return { filePaths: [rel], thinking: `${verb} ${base(rel)}` }
}

/** Folds a later tool use into a pending one: paths kept in order (deduped, capped), latest cue wins. */
export function mergeActivity(a: ToolActivity | null, b: ToolActivity): ToolActivity {
  if (!a) return { filePaths: b.filePaths.slice(0, MAX_PATHS), thinking: b.thinking }
  const paths = [...a.filePaths]
  for (const p of b.filePaths) if (!paths.includes(p) && paths.length < MAX_PATHS) paths.push(p)
  return { filePaths: paths, thinking: b.thinking || a.thinking }
}
