# Quiet Server

> **The dev servers of the project and branch you are working on, one command away.**

A Claude Code mod in the spirit of [Port Menu](https://github.com/wieandteduard/port-menu), tied to the conversation instead of the menu bar: it knows which project and branch Claude is working in, what that project can launch, and what is already running.

It stays out of the way: a count in the status line, and the details in a pane when you ask.

## What it shows

**Status line**: `servers  ○ 0/3 here  ⋅  ● 1 elsewhere`, the servers of this branch that run out of all it runs or can launch, then what runs elsewhere. A full dot marks a figure where something runs, an empty dot one where nothing does.

**`/quiet-server`** opens or closes a pane in two sections, one under the other.

- **This project**
  - *The conversation's branch*: its servers that run, then what it can launch: the `package.json` scripts that serve (`dev`, `start`, `serve`, `preview`, `storybook`…) and the entries of `.claude/launch.json`, the file the desktop app's previews already read.
  - *Other branches*: servers started from another worktree of the same repository.
- **Running elsewhere**: every other dev server on the machine, grouped by project, each group headed by its branch and the folder it sits in (`claude-mod-quiet-cost  ⑂ main  ~/…/2026 Claude mods`).

Each server takes two lines: its name and what it is (`dev  Next.js app`), then what started it, how long it has been running, memory and CPU. What started it: `this pane`, `Claude, this conversation`, `Claude, another conversation`, the terminal app (`iTerm`, `Terminal`, `VS Code`…), or `detached` when what launched it is gone. A running server shows a small wave drifting slowly in a ring; one ready to launch, an empty dot. Its port sits on the right, on a slate ground while something listens on it.

Everything else is grey. Orange only marks something to look at: a server forgotten for a day, or a port another server already holds.

## Actions

| Button | Desktop | Terminal | What it does |
| --- | --- | --- | --- |
| Launch | filled play | `▶` | Runs the script through your login shell, so it finds `node` and `npm` as your terminal does |
| Open in Claude | window | (desktop only) | Opens `http://localhost:<port>` in a tab of Claude's own browser |
| Open in browser | arrow | `↗` | Opens it in your default browser |
| Stop | filled square | `■` | Stops the server and everything it started (`npm run dev` and its children), forcing it after 3 s |
| Port | `:3000` | `:3000` | Copies the URL |
| Launch all | in the project's title line | same | Launches this branch's dev servers at once (not `start`, `serve` or `preview`, which serve a build) |
| Stop all | in each section's title line | same | Stops every server of the section; press twice to confirm |
| Add | plus, on the project's title line | `add` | Puts a request in the prompt box: ask Claude to add a server to `.claude/launch.json` |
| Find | magnifier, next to it | `find` | Puts a request in the prompt box: ask Claude to look for servers the project could list |

A server launched from the pane lives as long as the Claude session: closing the session stops it. Servers started anywhere else (a terminal, Claude itself) are listed too, and can be stopped from here.

## Commands

- `/quiet-server`: open or close the pane.
- `/quiet-server status`: hide or show the count in the status line.
- `/quiet-server demo`: show made-up servers (a project with worktrees, a busy machine) to see the layout; again to come back.

The choice is kept across sessions.

## How it finds servers

Every 5 seconds it reads, on macOS:

- `lsof` for the processes listening on TCP, and their working folder;
- `ps` for uptime, memory and CPU;
- `git` for each folder's repository, worktree and branch.

Only processes running from a folder in your home are kept: apps opened from the Finder, and Claude itself, are left out.

## Install

Requires Claude Code 2.1.287 or later, on macOS.

```bash
claude --plugin-dir /path/to/claude-mod-quiet-server
```

## License

MIT
