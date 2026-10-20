<p align="center">
  <img src="https://github.com/arthurglaizal/quiet-server/releases/download/v2.0.0/quiet-server.gif" alt="Quiet Server demo: the count in the status line, then the pane that launches this branch's servers and lists what runs elsewhere" width="100%">
</p>

# Quiet Server

> **Launch your servers without leaving the conversation and catch the ones still running elsewhere.**

A Claude Code mod in the spirit of [Port Menu](https://github.com/wieandteduard/port-menu), tied to the conversation instead of the menu bar: it knows which project and branch Claude is working in, what that project can launch, and what is already running.

It stays out of the way: a count in the status line, and the details in a pane when you ask.

## What it shows

**Status line**: the servers of this branch that run, out of all it runs or can launch, then what runs elsewhere on the machine. On the desktop, a `⊙` button beside it opens or closes the pane.

```txt
quiet-server  0/3 here  1 elsewhere
```

**`/quiet-server`** opens or closes a pane in two sections, one under the other.

- **This project**, its name under the title
  - *The conversation's branch*, tagged `here` (hover it for what it means): its servers that run, then what it can launch: the `package.json` scripts that serve (`dev`, `start`, `serve`, `preview`, `storybook`…, but not the ones that only control a server, like `dev:stop` or `dev:status`) and the entries of `.claude/launch.json`, the file the desktop app's previews already read.
  - *Other branches*, one group each under a chevron: `main` first, with an anchor, then every other worktree of the repository, each with what runs and what it can launch. This branch, `main` and any branch where a server runs are open; the others stay folded, their head saying what they hold (`1 running · 3 to launch`). A fold you press is kept.
  - *Branches with no worktree*: folded on one line, each with **Create worktree**. A server needs a folder checked out on its branch, so `main` without one shows the same button.
- **Running elsewhere**: every other dev server on the machine, grouped by project, each group headed by its name and the folder it sits in (`migration-framer-to-vibecode · ~/…/2026 Migration Framer Vibecode`), then a line per branch it runs from: two worktrees of one repository are one project.

Each server takes two lines: its name and what it is (`dev  Next.js app`), then what started it, how long it has been running, memory and CPU. What started it: `this pane`, `Claude, this conversation`, `Claude, another conversation`, the terminal app (`iTerm`, `Terminal`, `VS Code`…), or `detached` when what launched it is gone. A running server shows a small wave drifting slowly in a ring; one ready to launch, an empty dot. Its port sits on the right, in a thin outline while something listens on it.

Everything else is grey. Orange only marks something to look at: a server forgotten for a day, or a port another server already holds (two branches running `dev` often want the same port).

## Install

```sh
claude plugin marketplace add arthurglaizal/quiet-server
claude plugin install quiet-server@quiet-server
```

Start a new session and the count appears in the status line. To update later: `claude plugin update quiet-server@quiet-server`. To try it without installing, clone the repository and run `claude --plugin-dir ./quiet-server`.

## How to use

| Button | Desktop | Terminal | What it does |
| --- | --- | --- | --- |
| Launch | filled play | `▶` | Runs the script through your login shell, so it finds `node` and `npm` as your terminal does |
| Copy address | two sheets | (desktop only) | Copies `http://localhost:<port>` |
| Open in browser | arrow | `↗` | Opens it in your default browser |
| Stop | filled square | `■` | Stops the server and everything it started (`npm run dev` and its children), forcing it after 3 s |
| Port | `:3000` | `:3000` | On the desktop, a label (Copy address copies it); in the terminal, copies the URL |
| Launch all | in the project's title line | same | Launches this branch's dev servers at once (not `start`, `serve` or `preview`, which serve a build); shown when there are two or more |
| Stop all | in each section's title line | same | Stops every server of the section; press twice to confirm; shown when two or more run |
| Fold | a branch's head | `▾` / `▸` | Opens or folds that branch's group |
| Launch | on another branch's head | `▶ launch` | Launches that branch's dev servers, from its own worktree |
| Create worktree | on a branch with no worktree | `create worktree` | Puts a request in the prompt box: ask Claude to create a worktree for that branch in `.claude/worktrees/` |
| Add | plus, on the project's title line | `add` | Puts a request in the prompt box: ask Claude to add a server to `.claude/launch.json` |
| Find | magnifier, next to it | `find` | Puts a request in the prompt box: ask Claude to look for servers the project could list |
| Count | a window with its bottom strip, last on the project's title line | `hide count` / `show count` | Shows or hides the count in the status line, and the pane's button beside it |

A server launched from the pane lives as long as the Claude session: closing the session stops it. Servers started anywhere else (a terminal, Claude itself) are listed too, and can be stopped from here.

| Command | What it does |
| --- | --- |
| `/quiet-server` | Opens or closes the pane |
| `/quiet-server status` | Hides or shows the count in the status line, as the pane's Count button does. The choice is kept across sessions |
| `/quiet-server demo` | Shows made-up servers (a project with worktrees, a busy machine) to see the layout; again to come back |

## Limitations

- macOS only: it reads the ports with `lsof` and `ps`.
- Needs Claude Code 2.1.287 or later. An update can change the mod API.
- Only processes running from a folder in your home are listed: apps opened from the Finder, and Claude itself, are left out.
- On the desktop, the first click in the pane can only bring it into focus; click again to press the button.

## What it runs and keeps

- **No network requests.** Everything it reads is on your machine. Nothing leaves it except on your click: the address you copy goes to the clipboard, Open in browser hands it to your browser, and Add and Find put a request in the prompt box, which you send or not.
- **Every 5 seconds**: `lsof` for the processes listening on TCP and their folder, `ps` for uptime, memory and CPU, and `git` for each folder's repository, worktree and branch. Every 30 seconds, `git worktree list`, `git for-each-ref` and `git symbolic-ref` for the repository's other worktrees, its branches and its default branch, and each worktree's `package.json` and `.claude/launch.json`. It reads branches, it never switches one.
- **Only on click**: your login shell (`$SHELL -lc`) to run the script you launch, as written in `package.json` or `.claude/launch.json`, so it finds `node` and `npm` as your terminal does; `kill` to stop a server and what it started; `open` to open its address in your browser.
- **Hooks**:
  - `command.run`, only for `/quiet-server`: opens or closes the pane and answers the command itself. It never sees or changes any other command, its own or another plugin's, and never touches a permission.
  - `ui.render`: draws the pane, and the `⊙` button beside the status line on the desktop.
  - `session.start`: registers `/quiet-server`, sets the status line and starts reading the ports.
- **One value kept on your machine**: whether you hid the count.

## Repository structure

```txt
quiet-server/
├── README.md
├── LICENSE
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── hooks/
│   ├── hooks.json
│   └── register.tsx
├── types/index.d.ts
└── tests/quiet-server.test.tsx
```

Run the checks with `claude plugin validate .` and `claude plugin test .`.

## Quiet mods

<p align="center">
  <img src="https://github.com/arthurglaizal/quiet-model/releases/download/v2.0.0/quiet-mods.png" alt="Quiet Token Bar and Quiet Model stacked above the Claude Code prompt" width="100%">
</p>

The Quiet mods share one design: grey by default, color only when something needs you.

| Mod | Description |
| --- | --- |
| [Quiet&nbsp;Token&nbsp;Bar](https://github.com/arthurglaizal/quiet-token-bar) | Your context window in one quiet line: a patterned bar, a compact button and your session and weekly limits, grey until something gets warm. |
| [Quiet&nbsp;Model](https://github.com/arthurglaizal/quiet-model) | Pick the model and effort in one quiet grey row. Or let Magic Router choose for each message. |
| [Quiet&nbsp;Cost](https://github.com/arthurglaizal/quiet-cost) | What each reply cost, in one quiet grey line under it: an estimated price, the time and the tokens, and more figures you pick. |

## Support

If you find my work useful, you can [buy me a coffee](https://ko-fi.com/arturo_ux) ☕️

## License

MIT — see [LICENSE](LICENSE).
