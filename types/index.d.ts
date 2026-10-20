// The pane's two sections, each with its own "Stop all".
export type Section = 'project' | 'elsewhere'

// Something the project can run: a package.json script that serves, or an entry of .claude/launch.json.
export type Launchable = {
  id: string
  name: string
  script?: string // the package.json script it runs, when it runs one
  command: string // what it runs, as shown
  run: string // the shell line that starts it
  cwd: string
  source: 'package.json' | 'launch.json'
  port?: number // when the command or the entry names one
  description: string // "Next.js app", from the command
}

// What started a server, from the processes above it: this pane, Claude in this conversation or another one, a
// terminal (named when it is a known app), or nothing left, its launcher gone ("detached").
export type Origin = { kind: 'pane' | 'conversation' | 'claude' | 'terminal' | 'detached' | 'unknown'; app?: string }

// A dev server listening on this machine.
export type Server = {
  pid: number // the process that listens
  pids: number[] // everything it runs: the launcher (npm run dev) and its children
  name: string
  description: string
  ports: number[]
  cwd: string
  top: string // the working tree it runs from
  repo: string // the repository, the same for every worktree of it
  projectName: string
  branch: string
  uptimeMs: number
  rssKb: number
  cpu: number
  origin: Origin
}

// Where this conversation works.
export type Project = {
  cwd: string
  top: string
  repo: string
  name: string
  branch: string
}

// Another worktree of the conversation's repository: its branch, or none ("detached"), and what it can launch.
export type Worktree = { top: string; branch: string; isDetached: boolean; launchables: Launchable[] }

export type Snapshot = {
  project: Project
  launchables: Launchable[]
  servers: Server[]
  worktrees?: Worktree[] // the repository's other worktrees
  branches?: string[] // its local branches
  trunk?: string // its default branch ("main"), or "" when none is found
}

declare module 'claude-code' {
  interface PluginState {
    'quiet-server': { snapshot: Snapshot | null; isStatusHidden: boolean; busy: string[]; confirming: Section | null; opened: Record<string, boolean> }
  }
}
