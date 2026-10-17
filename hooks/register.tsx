// Quiet Server: the dev servers of this project, the ones that run and the ones ready to launch, and what runs elsewhere.
//   Port Menu, tied to the conversation. The status line keeps the count: this branch's servers that run out of all
//   it runs or can launch, and what runs elsewhere. The pane, which /quiet-server opens, has two sections, one under
//   the other. This project: what runs on the conversation's branch and what
//   it can launch (package.json scripts, .claude/launch.json), then the same project's servers on its other branches
//   (its other worktrees). Running elsewhere: every other dev server. Everything stays grey; a wave moves in what runs;
//   orange marks a server forgotten for a day, or a port another server already holds.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Launchable, Origin, Project, Section, Server, Snapshot } from '../types'

const PANE = 'servers'
const TICK = 5000 // how often the ports are read again while the bar or the pane shows
const IDLE_TICKS = 3 // and, with neither, every third tick: the count alone can wait
const FORGOTTEN = 24 * 3_600_000 // a server running longer than this is flagged
const GIT_TTL = 30_000 // a folder's repository and branch are read again after this
const WAVE_MS = 5000 // one wavelength of a running server's wave
const ORANGE = '#e08a3c'
// Absolute paths: the app's own PATH may not have the person's shell setup.
const BIN = { lsof: '/usr/sbin/lsof', ps: '/bin/ps', git: '/usr/bin/git', kill: '/bin/kill', open: '/usr/bin/open' } as const
const IGNORED = /^(claude|codex)$/i // assistants listening for their own reasons, not dev servers
// Never a server, never climbed through when stopping one: apps, the program in an app's MacOS folder (Claude's own
// binary among them), and assistants. Python.app is no app: it is how macOS's own python3 runs, from Xcode's folder.
const FOREIGN = /(?<!Python)\.app\/Contents\/MacOS\/|(^|\/)(claude|codex)(\s|$)|@anthropic-ai\/claude-code|@openai\/codex/
const GLYPH = { running: '◉', ready: '○', starting: '◌', stopping: '◉', preview: '⊞', open: '↗', stop: '■', start: '▶' } as const
const BROWSER = 'Claude_Browser' // the desktop app's own browser, served to the session as an MCP server
// What the two "ask Claude" buttons put in the prompt box, for the person to complete or send.
const ASK = {
  add: 'Add a dev server to this project\'s .claude/launch.json (name, runtimeExecutable, runtimeArgs, port): ',
  find: 'Look through this project (package.json scripts, docker-compose, Makefile, READMEs, subfolders) for dev servers that .claude/launch.json does not list yet, and add the useful ones to it.',
} as const
const EMPTY = ['Nothing to run here yet.', 'Scripts named dev, start, serve, preview or storybook in package.json, and the entries of .claude/launch.json, show up here.']

// Held by the host, so the pane survives a hot reload of this file.
const snapshot = atom({ plugin: 'quiet-server', key: 'snapshot' } as const, null as Snapshot | null)
const isStatusHidden = atom({ plugin: 'quiet-server', key: 'isStatusHidden' } as const, false)
const busy = atom({ plugin: 'quiet-server', key: 'busy' } as const, [] as string[]) // rows starting or stopping, by key
const confirming = atom({ plugin: 'quiet-server', key: 'confirming' } as const, null as Section | null) // "Stop all" pressed once, there

// The module's own: a reload starts them over, and ends the servers this session launched with their loops.
const launched = new Map<string, AsyncGenerator<unknown, unknown>>() // by launchable id
const gitCache = new Map<string, { at: number; info: GitInfo | null }>()
const phases = new Map<string, number>() // each running row's place in its wave, so every wave moves in step
let isRefreshing = false
let shownStatus: string | undefined
let ticks = 0
let isDemo = false // /quiet-server demo: made-up servers in the pane and the status line, to see the layout

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'quiet-server', description: 'Open the servers pane (/quiet-server status hides or shows the count)' }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    const statusHidden = (await $.store.get('isStatusHidden').catch(() => undefined)) === true
    await update($, isStatusHidden, () => statusHidden)
    void refresh($).catch(() => {})
    $.clock.every(TICK, () => void tick($).catch(() => {}))
    return r
  })

  on('command.run', { command: 'quiet-server' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'status') {
      const hidden = await update($, isStatusHidden, h => !h)
      await $.store.set('isStatusHidden', hidden).catch(() => {})
      await showStatus($)
      return { text: hidden ? 'Server count hidden. /quiet-server status shows it again' : 'Server count back in the status line' }
    }
    if (arg === 'demo') {
      isDemo = !isDemo
      if (isDemo) await update($, snapshot, () => demoSnapshot())
      else void refresh($).catch(() => {})
      await showStatus($)
      return { text: isDemo ? 'Demo servers shown; /quiet-server demo brings the real ones back' : 'Real servers back' }
    }
    return { text: await togglePane($) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, snapshot)
    if (!s) return <Text dimColor>Reading the ports…</Text>
    const v = sections(s, await read($, busy))
    const bulk = bulkActions($, v, await read($, confirming))
    const inner = Math.max(30, e.props.bodyColumns - 2) // no border: the padding takes 2 cells
    const surface = e.surface
    const actions = (row: Row) => rowActions($, s, row, surface)
    const copyPort = (row: Row) => () => void copy($, `http://localhost:${row.port}`, surface)
    const branchLine = s.project.branch ? `${s.project.branch} · this conversation` : ''
    // The two that ask Claude: add a server, or look for ones to add. Both fill the prompt; the person sends it.
    const asks = [
      { key: 'ask-add', icon: 'add' as const, tip: 'Ask Claude to add a server', label: 'add', press: () => void ask($, 'add') },
      { key: 'ask-find', icon: 'find' as const, tip: 'Ask Claude to look for servers to add', label: 'find', press: () => void ask($, 'find') },
    ]
    const elsewhereCount = v.elsewhere.length ? String(v.elsewhere.length) : ''

    // The surfaces with a vector element draw small text as SVG; the terminal draws the same rows in characters.
    const Svg = (e.surface === 'terminal' ? undefined : ($.ui.resolve(e) as any).Svg) as ((props: { source: string; alt: string; width?: number; height?: number }) => any) | undefined
    if (Svg) {
      const drawn = Math.round(inner * PX_PER_COLUMN)
      const textWidth = Math.max(160, drawn - IND_W - Math.round((TAG_CELLS + BUTTON_CELLS) * PX_PER_COLUMN) - 16)
      keepPhases(v, await $.clock.now())
      // A tip under its button, ending at the button's right edge, on a card of its own as quiet-model's pane draws
      // them (the app draws none in a pane). The tree is turned over at the end so a tip covers the rows below.
      const tip = (text: string) => (
        <Box position="absolute" top={1} right={0} width={text.length + 4} display="none" hover={{ display: 'flex' }} backgroundColor={TIP.card} borderStyle="round" borderColor={TIP.border} paddingX={1}>
          <Text color={TIP.name}>{text}</Text>
        </Box>
      )
      // A row's button: a filled icon on a faint ground, an empty button over the whole box, and a short tooltip.
      const iconButton = (b: { key: string; svg: string; tip: string; press: () => void }) => (
        <Box key={`${b.key}-box`} width={BUTTON_BOX} height={1} marginLeft={1} justifyContent="center" alignItems="center">
          <Svg source={b.svg} alt={b.tip} width={BTN_W} height={BTN_H} />
          <Box position="absolute" top={0} left={0} width={BUTTON_BOX} height={1}>
            <Button key={b.key} plain onPress={b.press}>
              {'\u00A0'.repeat(BUTTON_BOX)}
            </Button>
          </Box>
          {tip(b.tip)}
        </Box>
      )
      // A section's quick action ("Launch all", "Stop all"): drawn small, with an empty button over it.
      const wordButton = (b: Bulk) => {
        const width = Math.ceil((b.label.length * SMALL_WIDTH + 19) / PX_PER_COLUMN)
        return (
          <Box key={`${b.key}-box`} width={width} height={1} marginLeft={2}>
            <Svg source={wordSvg(b.label, width * PX_PER_COLUMN, b.glyph, b.isWarm)} alt={b.label} />
            <Box position="absolute" top={0} left={0} width={width} height={1}>
              <Button key={b.key} plain onPress={b.press}>
                {'\u00A0'.repeat(width)}
              </Button>
            </Box>
            {tip(b.tip)}
          </Box>
        )
      }
      // The title line's small stroked buttons: a stroked ICON px icon in a box of two cells, an empty button over it.
      const smallButton = (b: { key: string; svg: string; tip: string; press: () => void }) => (
        <Box key={`${b.key}-box`} width={2} height={1} marginLeft={2} justifyContent="center" alignItems="center">
          <Svg source={b.svg} alt={b.tip} width={ICON} height={ICON} />
          <Box position="absolute" top={0} left={0} width={2} height={1}>
            <Button key={b.key} plain onPress={b.press}>
              {'\u00A0\u00A0'}
            </Button>
          </Box>
          {tip(b.tip)}
        </Box>
      )
      // After "This project": the two asks.
      const extras = asks.map(a => smallButton({ key: a.key, svg: paneIcon(a.icon), tip: a.tip, press: a.press }))
      const header = (title: string, detail: string, list: Bulk[], extra: any[] = []) => (
        <Box flexDirection="row" alignItems="center">
          <Box flexShrink={1}>
            <Svg source={sectionSvg(title, detail, Math.max(160, drawn - list.length * 110 - extra.length * 34))} alt={`${title}, ${detail}`} />
          </Box>
          <Box flexGrow={1} />
          {list.map(wordButton)}
          {extra}
        </Box>
      )
      // A server on two lines. The state is a drawing of its own that stays the same between reads, so its wave
      // keeps moving; the port, when something listens on it, copies the URL.
      const rowView = (row: Row) => {
        const live = row.state === 'running' && row.port !== undefined
        return (
          <Box key={row.key} flexDirection="row" alignItems="center">
            <Svg source={indicatorSvg(row.state, phases.get(row.key))} alt={row.state} width={IND_W} height={ROW_H} />
            <Box flexShrink={1}>
              <Svg source={rowSvg(row, textWidth)} alt={rowAlt(row)} />
            </Box>
            <Box flexGrow={1} />
            {/* Keyed: a tip shows while the pointer is over its nearest keyed Box, so this one only over the port. */}
            <Box key={`${row.key}:port-box`} width={TAG_CELLS} height={1} flexDirection="row" justifyContent="flex-end" alignItems="center">
              {row.port !== undefined && <Svg source={portSvg(row)} alt={`port ${row.port}`} />}
              {live && (
                <Box position="absolute" top={0} right={0} width={TAG_CELLS} height={1}>
                  <Button key={`${row.key}:copy`} plain onPress={copyPort(row)}>
                    {'\u00A0'.repeat(TAG_CELLS)}
                  </Button>
                </Box>
              )}
              {live && tip('Copy URL')}
            </Box>
            <Box width={BUTTON_CELLS} flexDirection="row" justifyContent="flex-end">
              {actions(row).map(a => iconButton({ key: `${row.key}:${a.kind}`, svg: buttonSvg(a.kind), tip: a.tip, press: a.press }))}
            </Box>
          </Box>
        )
      }
      return overTheNext(
        <Box flexDirection="column" paddingX={1}>
          {header('This project', s.project.name, bulk.project, extras)}
          {branchLine && <Svg source={branchSvg(s.project.branch, drawn)} alt={branchLine} />}
          {v.here.length === 0 && <Svg source={emptySvg(EMPTY, drawn)} alt={EMPTY.join(' ')} />}
          {v.here.map(rowView)}
          {v.other.length > 0 && <Box height={1} />}
          {v.other.length > 0 && <Svg source={captionSvg('Other branches', drawn, true)} alt="Other branches" />}
          {v.other.map(rowView)}
          <Svg source={ruleSvg(drawn)} alt="Divider" />
          {header('Running elsewhere', elsewhereCount, bulk.elsewhere)}
          {v.elsewhere.length === 0 && <Svg source={emptySvg(['Nothing else is running.'], drawn)} alt="Nothing else is running." />}
          {groups(v.elsewhere).map((g, i) => (
            <Box key={g.key} flexDirection="column">
              <Svg source={groupSvg(g, drawn, i > 0)} alt={[g.name, g.branch, g.folder].filter(Boolean).join(', ')} />
              {g.rows.map(rowView)}
            </Box>
          ))}
          <Box height={2} />
        </Box>,
      )
    }

    // The terminal: the same sections, each server on two lines.
    const termHeader = (title: string, detail: string, list: Bulk[], withAsks = false) => (
      <Box flexDirection="row">
        <Text>{title}</Text>
        <Text dimColor wrap="truncate-end">{`  ${detail}`}</Text>
        <Box flexGrow={1} />
        {list.map(b => (
          <Box key={`${b.key}-box`} marginLeft={2}>
            <Button key={b.key} plain dimColor={!b.isWarm} onPress={b.press}>
              {`${b.glyph ? `${GLYPH[b.glyph]} ` : ''}${b.label}`}
            </Button>
          </Box>
        ))}
        {withAsks &&
          asks.map(a => (
            <Box key={`${a.key}-box`} marginLeft={2}>
              <Button key={a.key} plain dimColor onPress={a.press}>
                {a.label}
              </Button>
            </Box>
          ))}
      </Box>
    )
    const termRow = (row: Row) => {
      const isOn = row.state === 'running' || row.state === 'stopping'
      const live = row.state === 'running' && row.port !== undefined
      const warm = row.note !== undefined
      return (
        <Box key={row.key} flexDirection="column">
          <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text dimColor={!isOn}>
                {GLYPH[row.state]}
              </Text>
            </Box>
            <Box flexShrink={1}>
              <Text wrap="truncate-end">
                <Text dimColor={!isOn}>{row.name}</Text>
                <Text dimColor>{row.description ? `  ${row.description}` : ''}</Text>
              </Text>
            </Box>
            <Box flexGrow={1} />
            <Box width={TAG_CELLS} flexShrink={0} flexDirection="row" justifyContent="flex-end">
              {live ? (
                <Button key={`${row.key}:copy`} plain onPress={copyPort(row)}>
                  {`:${row.port}`}
                </Button>
              ) : (
                <Text color={warm ? ORANGE : undefined} dimColor={!warm} bold={warm}>
                  {row.port === undefined ? '' : `:${row.port}`}
                </Text>
              )}
            </Box>
            <Box width={5} flexShrink={0} flexDirection="row" justifyContent="flex-end">
              {actions(row).map(a => (
                <Box key={`${row.key}:${a.kind}-box`} marginLeft={1}>
                  <Button key={`${row.key}:${a.kind}`} plain dimColor onPress={a.press}>
                    {GLYPH[a.kind]}
                  </Button>
                </Box>
              ))}
            </Box>
          </Box>
          <Box flexDirection="row">
            <Box width={2} flexShrink={0} />
            <Text wrap="truncate-end">
              {row.meta.map((p, i) => (
                <Text key={`${row.key}:meta:${i}`} color={p.isWarm ? ORANGE : undefined} dimColor={!p.isWarm} bold={p.isWarm}>
                  {`${i ? ' · ' : ''}${p.text}`}
                </Text>
              ))}
            </Text>
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        {termHeader('This project', s.project.name, bulk.project, true)}
        {branchLine && <Text dimColor wrap="truncate-end">{branchLine}</Text>}
        {v.here.length === 0 && EMPTY.map(t => <Text key={`empty:${t}`} dimColor>{t}</Text>)}
        {v.here.map(termRow)}
        {v.other.length > 0 && (
          <Box marginTop={1}>
            <Text dimColor>Other branches</Text>
          </Box>
        )}
        {v.other.map(termRow)}
        <Box marginTop={1} marginBottom={1}>
          <Text dimColor>{'─'.repeat(inner)}</Text>
        </Box>
        {termHeader('Running elsewhere', elsewhereCount, bulk.elsewhere)}
        {v.elsewhere.length === 0 && <Text dimColor>Nothing else is running.</Text>}
        {groups(v.elsewhere).map((g, i) => (
          <Box key={g.key} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
            <Text wrap="truncate-end">
              <Text>{g.name}</Text>
              <Text dimColor>{`${g.branch ? `  ⑂ ${g.branch}` : ''}  ${g.folder}`}</Text>
            </Text>
            {g.rows.map(termRow)}
          </Box>
        ))}
      </Box>
    )
  })
}

// A note on hover is painted over what comes before it in the tree, not over what comes after: a row's tip would
// sit under the rows below. Every column turned upside down in the tree, drawn the right way up with
// `column-reverse`, puts each row after the rows below it, so its tip covers them.
export function overTheNext(node: any): any {
  if (!node || typeof node !== 'object') return node
  const children = Array.isArray(node.children) ? node.children.flat(Infinity).map(overTheNext) : node.children
  if (node.type === 'Box' && node.props?.flexDirection === 'column' && Array.isArray(children)) {
    return { ...node, props: { ...node.props, flexDirection: 'column-reverse' }, children: [...children].reverse() }
  }
  return children === node.children ? node : { ...node, children }
}

// ——— What a row and a section offer ———

type Action = { kind: 'preview' | 'open' | 'stop' | 'start'; tip: string; press: () => void }

// A running server: open it in Claude's browser (the desktop app has one), in the default browser, or stop it.
function rowActions($: EngineInterface, s: Snapshot, row: Row, surface: string): Action[] {
  return isDemo ? realActions($, s, row, surface).map(a => ({ ...a, press: demoPress($) })) : realActions($, s, row, surface)
}

const demoPress = ($: EngineInterface) => () => void $.ui.toast('Demo servers: nothing to act on. /quiet-server demo brings the real ones back')

function realActions($: EngineInterface, s: Snapshot, row: Row, surface: string): Action[] {
  if (row.state === 'starting' || row.state === 'stopping') return []
  if (row.state === 'ready') return row.launchable ? [{ kind: 'start', tip: 'Launch', press: () => void start($, row.launchable!) }] : []
  const url = row.port ? `http://localhost:${row.port}` : undefined
  const out: Action[] = []
  if (url && surface === 'desktop') out.push({ kind: 'preview', tip: 'Open in Claude', press: () => void preview($, url) })
  if (url) out.push({ kind: 'open', tip: 'Open in browser', press: () => void open($, url) })
  out.push({ kind: 'stop', tip: 'Stop', press: () => void stop($, s, row.server!) })
  return out
}

type Bulk = { key: string; label: string; tip: string; glyph?: 'start' | 'stop'; isWarm?: boolean; press: () => void }

// "Launch all" over this branch's dev servers, "Stop all" over a section's servers: only when there are two or more.
function bulkActions($: EngineInterface, v: Sections, asking: Section | null): Record<Section, Bulk[]> {
  const batch = launchBatch(v.here)
  const stopAll = (section: Section, rows: Row[]): Bulk[] => {
    const n = rows.filter(r => r.state === 'running').length
    if (n < 2) return []
    const isAsking = asking === section
    const tip = isAsking ? 'Press again to stop them' : `Stop the ${n} servers ${section === 'project' ? 'of this project' : 'running elsewhere'}`
    return [{ key: `stop-${section}`, label: isAsking ? `Confirm stop (${n})` : 'Stop all', tip, glyph: 'stop', isWarm: isAsking, press: () => void pressStopAll($, section) }]
  }
  const launchAll: Bulk[] = batch.length < 2 ? [] : [{ key: 'launch-all', label: 'Launch all', tip: `Launch ${batch.map(l => l.name).join(', ')}`, glyph: 'start', press: () => void startAll($) }]
  const out = { project: [...launchAll, ...stopAll('project', [...v.here, ...v.other])], elsewhere: stopAll('elsewhere', v.elsewhere) }
  if (isDemo) for (const list of Object.values(out)) for (const b of list) b.press = demoPress($)
  return out
}

// Made-up servers, as a project with worktrees and a busy machine would show: this branch running one of three,
// launched from the pane, another worktree on main, and four elsewhere in three projects, started from a terminal,
// another conversation, or left detached and forgotten for days.
export function demoSnapshot(): Snapshot {
  const home = '/Users/me/code'
  const top = `${home}/atelier-web`
  const repo = `${top}/.git`
  const launchable = (name: string, command: string, port: number): Launchable => ({ id: `${top}#${name}`, name, script: name, command, run: `npm run ${name}`, cwd: top, source: 'package.json', port, description: describe(command) })
  const server = (pid: number, name: string, command: string, ports: number[], cwd: string, git: { top: string; repo: string; name: string; branch: string } | null, minutes: number, mb: number, cpu: number, origin: Origin): Server => ({
    pid,
    pids: [pid],
    name,
    description: describe(command),
    ports,
    cwd,
    top: git?.top ?? cwd,
    repo: git?.repo ?? cwd,
    projectName: git?.name ?? basename(cwd),
    branch: git?.branch ?? '',
    uptimeMs: minutes * 60_000,
    rssKb: mb * 1024,
    cpu,
    origin,
  })
  const mainTree = `${home}/atelier-web-main`
  return {
    project: { cwd: top, top, repo, name: 'atelier-web', branch: 'feat/checkout' },
    launchables: [launchable('dev', 'next dev -p 3001', 3001), launchable('storybook', 'storybook dev -p 6006', 6006), launchable('preview', 'next start -p 4173', 4173)],
    servers: [
      server(90001, 'dev', 'npm run dev\nnode .bin/next dev -p 3001', [3001], top, { top, repo, name: 'atelier-web', branch: 'feat/checkout' }, 12, 310, 3, { kind: 'pane' }),
      server(90002, 'dev', 'npm run dev\nnode .bin/next dev', [3000], mainTree, { top: mainTree, repo, name: 'atelier-web', branch: 'main' }, 130, 280, 1, { kind: 'terminal', app: 'iTerm' }),
      server(90003, 'vite', 'node .bin/vite', [5173], `${home}/portfolio`, { top: `${home}/portfolio`, repo: `${home}/portfolio/.git`, name: 'portfolio', branch: 'main' }, 3 * 1440 + 90, 190, 0, { kind: 'detached' }),
      server(90004, 'uvicorn', 'uvicorn main:app --port 8000', [8000], `${home}/api-billing`, { top: `${home}/api-billing`, repo: `${home}/api-billing/.git`, name: 'api-billing', branch: 'dev' }, 40, 95, 2, { kind: 'claude', app: 'another conversation' }),
      server(90005, 'dev', 'npm run dev\nnode .bin/astro dev', [4321], `${home}/docs`, { top: `${home}/docs`, repo: `${home}/docs/.git`, name: 'docs', branch: 'main' }, 65, 120, 0, { kind: 'terminal', app: 'Terminal' }),
      server(90006, 'storybook', 'npm run storybook\nnode .bin/storybook dev -p 6007', [6007], `${home}/docs`, { top: `${home}/docs`, repo: `${home}/docs/.git`, name: 'docs', branch: 'main' }, 64, 240, 1, { kind: 'terminal', app: 'Terminal' }),
    ],
  }
}

// What "Launch all" starts: the servers one works with, not the ones that serve a build (start, serve, preview),
// nor a second one on a port the batch already takes.
export function launchBatch(rows: Row[]): Launchable[] {
  const ports = new Set<number>()
  const out: Launchable[] = []
  for (const r of rows) {
    const l = r.launchable
    if (r.state !== 'ready' || !l || r.note || /^(start|serve|preview)($|:)/.test(l.script ?? l.name) || /\b(start|preview)\b/.test(l.command)) continue
    if (l.port !== undefined && ports.has(l.port)) continue
    if (l.port !== undefined) ports.add(l.port)
    out.push(l)
  }
  return out
}

// ——— The rows, as the pane shows them ———

export type Part = { text: string; isWarm?: boolean }

export type Row = {
  key: string
  section: 'here' | 'other' | 'elsewhere'
  state: 'running' | 'ready' | 'starting' | 'stopping'
  name: string
  description: string
  branch: string
  port?: number
  meta: Part[] // the second line: the branch, uptime, memory and CPU; or what a launch runs
  isForgotten: boolean
  note?: string // orange: "used by main", the port another server holds
  server?: Server
  launchable?: Launchable
}

export type Sections = { here: Row[]; other: Row[]; elsewhere: Row[] }

// This branch: what runs, then what it can launch. Other branches: the same project's other worktrees. Elsewhere:
// every other server, by project and port.
export function sections(s: Snapshot, pending: string[] = []): Sections {
  const { project, launchables, servers } = s
  const byPort = (a: Server, b: Server) => (a.ports[0] ?? 0) - (b.ports[0] ?? 0)
  // Without git, the tree is the folder itself: a server run from a subfolder of it is still this project's.
  const hasGit = (x: { top: string; repo: string }) => x.repo !== x.top
  const isMine = (x: Server) => x.top === project.top || (!hasGit(x) && !hasGit(project) && (x.cwd === project.top || x.cwd.startsWith(`${project.top}/`)))
  const mine = servers.filter(isMine).sort(byPort)
  // A server claims one launchable: the one it carries the name, script or port of, else the one whose command
  // runs the same program ("next" for `next dev`). Each launchable is claimed once: `next dev` leaves `start` ready.
  const claimed = new Set<string>()
  const claim = (sv: Server) => {
    const l = launchables.find(l => !claimed.has(l.id) && matches(l, sv)) ?? launchables.find(l => !claimed.has(l.id) && binaryName(l.command) === sv.name)
    if (l) claimed.add(l.id)
    return l
  }
  const running = mine.map(sv => serverRow(sv, 'here', claim(sv), pending))
  const ready = launchables.filter(l => !claimed.has(l.id)).map(l => readyRow(l, project, servers, pending))
  const other = servers.filter(x => x.repo === project.repo && !isMine(x)).sort(byPort)
  const elsewhere = servers.filter(x => x.repo !== project.repo && !isMine(x)).sort((a, b) => a.projectName.localeCompare(b.projectName) || byPort(a, b))
  return {
    here: [...running, ...ready],
    other: other.map(sv => serverRow(sv, 'other', undefined, pending)),
    elsewhere: elsewhere.map(sv => serverRow(sv, 'elsewhere', undefined, pending)),
  }
}

// "servers  ○ 0/0 here  ⋅  ● 1 elsewhere": what runs on this branch against all it runs or could launch, then what
// runs elsewhere. The status line is text: a full dot while something runs, an empty one while nothing does.
export function statusText(s: Snapshot) {
  const { here, elsewhere } = sections(s)
  const running = here.filter(r => r.server).length
  const mark = (n: number) => (n > 0 ? '●' : '○')
  return `servers  ${mark(running)} ${running}/${here.length} here  ⋅  ${mark(elsewhere.length)} ${elsewhere.length} elsewhere`
}

// A launchable is running when a server of its working tree carries its name, its script or its port.
export function matches(l: Launchable, sv: Server) {
  return sv.name === l.name || (l.script !== undefined && sv.name === l.script) || (l.port !== undefined && sv.ports.includes(l.port))
}

// A server goes by its script ("dev", then "Next.js app"); its second line starts with what started it. Elsewhere,
// its project and branch head its group, so the line does not repeat the branch.
function serverRow(sv: Server, section: Row['section'], l: Launchable | undefined, pending: string[]): Row {
  const key = `pid:${sv.pid}`
  const isStopping = pending.includes(key)
  const isForgotten = sv.uptimeMs > FORGOTTEN
  const origin = originText(sv.origin)
  return {
    key,
    section,
    state: isStopping ? 'stopping' : 'running',
    name: l?.name ?? sv.name,
    description: sv.description || l?.description || '',
    branch: sv.branch,
    port: sv.ports[0],
    meta: isStopping
      ? [{ text: 'Stopping…' }]
      : [...(origin ? [{ text: origin }] : []), ...(section !== 'other' || !sv.branch ? [] : [{ text: sv.branch }]), { text: duration(sv.uptimeMs), isWarm: isForgotten }, { text: memory(sv.rssKb) }, { text: `${Math.round(sv.cpu)}% CPU` }],
    isForgotten,
    server: sv,
    launchable: l,
  }
}

function readyRow(l: Launchable, project: Project, servers: Server[], pending: string[]): Row {
  const key = `launch:${l.id}`
  const isStarting = pending.includes(key)
  const holder = l.port === undefined ? undefined : servers.find(sv => sv.ports.includes(l.port!))
  const note = holder ? `used by ${holder.top === project.top ? holder.name : holder.branch || holder.projectName}` : undefined
  return {
    key,
    section: 'here',
    state: isStarting ? 'starting' : 'ready',
    name: l.name,
    description: l.description,
    branch: project.branch,
    port: l.port,
    meta: isStarting ? [{ text: 'Starting…' }] : [...(note ? [{ text: `port ${l.port} ${note}`, isWarm: true }] : []), { text: l.run }],
    isForgotten: false,
    note,
    launchable: l,
  }
}

// Running elsewhere, by project: one group per working tree, headed by its project, branch and folder, in the
// order the rows come (by project, then port).
export type Group = { key: string; name: string; branch: string; folder: string; rows: Row[] }
export function groups(rows: Row[]): Group[] {
  const out = new Map<string, Group>()
  for (const r of rows) {
    const sv = r.server!
    const g = out.get(sv.top) ?? { key: `group:${sv.top}`, name: sv.projectName, branch: sv.branch, folder: folderOf(sv.top), rows: [] }
    g.rows.push(r)
    out.set(sv.top, g)
  }
  return [...out.values()]
}

// The folder a project sits in, from the home folder ("~/code"), its middle cut when deep ("~/…/2026 Claude mods").
export function folderOf(top: string) {
  const parts = top.replace(/^\/Users\/[^/]+(?=\/|$)/, '~').split('/').slice(0, -1)
  return parts.length > 3 ? `${parts[0]}/…/${parts.at(-1)}` : parts.join('/') || '/'
}

const rowAlt = (row: Row) => [row.name, row.description, ...row.meta.map(p => p.text), row.port ? `port ${row.port}` : ''].filter(Boolean).join(', ')

// Each running row keeps the offset it got when it appeared: its satellite then sits where the clock's turn is,
// like every other one. Rows gone are forgotten.
function keepPhases(v: Sections, now: number) {
  const keys = new Set([...v.here, ...v.other, ...v.elsewhere].filter(r => r.state === 'running').map(r => r.key))
  for (const key of keys) if (!phases.has(key)) phases.set(key, -((now % WAVE_MS) / 1000))
  for (const key of phases.keys()) if (!keys.has(key)) phases.delete(key)
}

// ——— Reading the machine ———

type GitInfo = { top: string; repo: string; name: string; branch: string }

// Reads where the conversation works, what it can launch and what listens, then updates the pane and the count.
async function refresh($: EngineInterface) {
  if (isRefreshing || isDemo) return // one at a time: a slow read is not stacked on; the demo stays as it is
  isRefreshing = true
  try {
    const now = await $.clock.now()
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    const project = await projectOf($, await $.session.cwd(), now)
    const [launchables, servers] = await Promise.all([findLaunchables($, project), scanServers($, home, now)])
    const fresh: Snapshot = { project, launchables, servers }
    await update($, snapshot, () => fresh)
    // A launch is done once its server listens, a stop once its process is gone.
    const runningKeys = new Set(sections(fresh).here.filter(r => r.launchable && r.server).map(r => `launch:${r.launchable!.id}`))
    const pids = new Set(servers.map(sv => `pid:${sv.pid}`))
    await update($, busy, list => list.filter(k => (k.startsWith('launch:') ? !runningKeys.has(k) : pids.has(k))))
    await showStatus($)
  } finally {
    isRefreshing = false
  }
}

// A tick reads the machine while the pane shows, else one tick in IDLE_TICKS.
async function tick($: EngineInterface) {
  ticks++
  const isShown = (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
  if (isShown || ticks % IDLE_TICKS === 0) await refresh($)
}

// The count in the status line, unless /quiet-server status hid it.
async function showStatus($: EngineInterface) {
  const s = await read($, snapshot)
  const text = (await read($, isStatusHidden)) || !s ? undefined : statusText(s)
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

async function run($: EngineInterface, argv: string[], cwd?: string) {
  try {
    return await $.process.run(argv, { timeoutMs: 10_000, ...(cwd ? { cwd } : {}) })
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error), isStdoutTruncated: false, isStderrTruncated: false }
  }
}

// Cached for GIT_TTL, unless `isFresh`: the conversation's own folder is read every time, so a checkout shows at once.
async function gitInfo($: EngineInterface, dir: string, now: number, isFresh = false): Promise<GitInfo | null> {
  const kept = gitCache.get(dir)
  if (kept && !isFresh && now - kept.at < GIT_TTL) return kept.info
  const where = await run($, [BIN.git, '-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])
  // symbolic-ref, not rev-parse HEAD: it also answers in a repository with no commit yet.
  const head = where.exitCode === 0 ? await run($, [BIN.git, '-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD']) : undefined
  const info = where.exitCode === 0 ? toGitInfo(where.stdout, head?.exitCode === 0 ? head.stdout.trim() : 'detached') : null
  gitCache.set(dir, { at: now, info })
  return info
}

async function projectOf($: EngineInterface, cwd: string, now: number): Promise<Project> {
  const git = await gitInfo($, cwd, now, true)
  return git ? { cwd, ...git } : { cwd, top: cwd, repo: cwd, name: basename(cwd), branch: '' }
}

async function readJson($: EngineInterface, path: string): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

// The package.json scripts that serve, in the working tree's root and in the folder the conversation is in, and
// the entries of .claude/launch.json (the file the app's own previews read). An entry that runs a script stands for it.
async function findLaunchables($: EngineInterface, p: Project): Promise<Launchable[]> {
  const configs = launchConfigs(await readJson($, `${p.top}/.claude/launch.json`), p.top)
  const scripts: Launchable[] = []
  for (const dir of [...new Set([p.top, p.cwd])]) {
    const pkg = await readJson($, `${dir}/package.json`)
    if (pkg) scripts.push(...packageScripts(pkg, dir, await packageManager($, dir, p.top)))
  }
  const covered = new Set(configs.map(c => c.script).filter(Boolean))
  return [...configs, ...scripts.filter(l => !covered.has(l.name))]
}

async function packageManager($: EngineInterface, dir: string, top: string) {
  for (const base of [...new Set([dir, top])]) {
    for (const [file, pm] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']] as const) {
      if (await $.fs.exists(`${base}/${file}`).catch(() => false)) return pm
    }
  }
  return 'npm'
}

// Every process listening on TCP whose folder is one of the person's projects, grouped by what launched it.
async function scanServers($: EngineInterface, home: string, now: number): Promise<Server[]> {
  const listening = parseListeners((await run($, [BIN.lsof, '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])).stdout)
  const pids = [...listening.keys()].filter(pid => !IGNORED.test(listening.get(pid)!.command))
  if (pids.length === 0) return []
  const [cwdOut, psOut] = await Promise.all([
    run($, [BIN.lsof, '-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]),
    run($, [BIN.ps, '-axo', 'pid=,ppid=,etime=,rss=,%cpu=,command=']),
  ])
  const cwds = parseCwds(cwdOut.stdout)
  const procs = parsePs(psOut.stdout)
  const self = selfClaude(procs)
  const byRoot = new Map<number, Server>()
  for (const pid of pids) {
    const cwd = cwds.get(pid)
    if (!cwd || !procs.has(pid) || !isDevFolder(cwd, home) || FOREIGN.test(procs.get(pid)!.command)) continue // apps opened from the Finder run from "/"
    const root = launcher(pid, procs)
    const ports = listening.get(pid)!.ports
    const known = byRoot.get(root)
    if (known) {
      known.ports = [...new Set([...known.ports, ...ports])].sort((a, b) => a - b) // one server, several ports
      continue
    }
    const git = await gitInfo($, cwd, now)
    const family = [root, ...descendants(root, procs)]
    const chain = [...ancestors(pid, procs, root), pid].map(p => procs.get(p)!.command)
    byRoot.set(root, {
      pid,
      pids: family,
      name: scriptName(chain) ?? binaryName(procs.get(pid)!.command),
      description: describe(chain.join('\n')),
      ports,
      cwd,
      top: git?.top ?? cwd,
      repo: git?.repo ?? cwd,
      projectName: git?.name ?? basename(cwd),
      branch: git?.branch ?? '',
      uptimeMs: procs.get(root)!.elapsedMs,
      rssKb: family.reduce((n, p) => n + (procs.get(p)?.rssKb ?? 0), 0),
      cpu: family.reduce((n, p) => n + (procs.get(p)?.cpu ?? 0), 0),
      origin: originOf(root, procs, self),
    })
  }
  return [...byRoot.values()]
}

// ——— Acting on a server ———

async function mark($: EngineInterface, key: string, on: boolean) {
  await update($, busy, list => (on ? [...new Set([...list, key])] : list.filter(k => k !== key)))
}

// Runs the entry through the person's login shell, so it finds node and npm as their terminal does. The server
// lives as long as this session: closing the session, or reloading this mod, ends it.
async function start($: EngineInterface, l: Launchable) {
  const key = `launch:${l.id}`
  if (launched.has(l.id) || (await read($, busy)).includes(key)) return
  await mark($, key, true)
  const shell = (await $.env.get('SHELL').catch(() => undefined)) || '/bin/zsh'
  const child = $.process.spawn({ argv: [shell, '-lc', `exec ${l.run}`], cwd: l.cwd })
  launched.set(l.id, child)
  void (async () => {
    try {
      for await (const chunk of child) void chunk // the output is not kept yet
    } catch {
      void $.ui.toast(`Could not start ${l.name}`)
    } finally {
      launched.delete(l.id)
      await mark($, key, false).catch(() => {})
      void refresh($).catch(() => {})
    }
  })()
  for (const ms of [1500, 4000, 8000]) $.clock.after(ms, () => void refresh($).catch(() => {})) // until its port opens
  $.clock.after(20_000, () => void mark($, key, false).catch(() => {}))
}

// Asks the server and everything it runs to stop, then forces whatever is still there after 3 s.
async function stop($: EngineInterface, s: Snapshot, sv: Server) {
  await mark($, `pid:${sv.pid}`, true)
  const own = s.launchables.find(l => sv.top === s.project.top && matches(l, sv) && launched.has(l.id))
  if (own) void launched.get(own.id)!.return(undefined) // one this session launched: ending its loop ends it
  const pids = sv.pids.filter(p => p > 1).map(String)
  await run($, [BIN.kill, '-TERM', ...pids])
  $.clock.after(800, () => void refresh($).catch(() => {}))
  $.clock.after(3000, () => {
    void (async () => {
      if ((await run($, [BIN.kill, '-0', String(sv.pid)])).exitCode === 0) await run($, [BIN.kill, '-KILL', ...pids])
      await refresh($)
    })().catch(() => {})
  })
}

// Puts a request in the prompt box, for the person to complete (add) or send as is (find).
async function ask($: EngineInterface, what: keyof typeof ASK) {
  const done = await $.prompt.fill({ text: ASK[what], mode: 'replace' }).catch(() => undefined)
  void $.ui.toast(done?.isFilled ? 'Prompt filled: complete it and send' : 'Could not fill the prompt')
}

// Opens the pane, or closes it when it is up: the command and the bar's button.
async function togglePane($: EngineInterface) {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane?.isShown) {
    await $.ui.close({ id: PANE })
    return 'Servers pane closed'
  }
  void refresh($).catch(() => {})
  const opened = await $.ui.open({ id: PANE, title: 'Servers' })
  return opened.isPlaced ? 'Servers pane opened' : `Servers pane waiting: ${opened.reason}`
}

// Claude's own browser: a tab at the URL, through the browser the desktop app serves the session.
// Says why, when it fails: the server's own words, or the refusal's.
async function preview($: EngineInterface, url: string) {
  const done = await $.mcp.call(BROWSER, 'preview_start', { url }).catch((error: unknown) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }))
  if (!done.isError) return
  const said = (done.content as { type: string; text?: string }[]).find(c => c.type === 'text')?.text ?? ''
  void $.ui.toast(`Could not open it in Claude's browser${said ? `: ${said.slice(0, 140)}` : ''}`)
}

async function open($: EngineInterface, url: string) {
  const done = await run($, [BIN.open, url])
  if (done.exitCode !== 0) void $.ui.toast(`Could not open ${url}: ${done.stderr.trim().slice(0, 140) || `exit ${done.exitCode}`}`)
}

async function copy($: EngineInterface, url: string, surface: string) {
  const done = await $.ui.copy({ text: url, surface: surface as any }).catch(() => undefined)
  void $.ui.toast(done?.isCopied ? `Copied ${url}` : `Could not copy ${url}`)
}

async function startAll($: EngineInterface) {
  const s = await read($, snapshot)
  if (!s) return
  for (const l of launchBatch(sections(s, await read($, busy)).here)) await start($, l)
}

// "Stop all" asks once more, for 5 s, before stopping every server of its section.
async function pressStopAll($: EngineInterface, section: Section) {
  const s = await read($, snapshot)
  if (!s) return
  if ((await read($, confirming)) !== section) {
    await update($, confirming, () => section)
    $.clock.after(5000, () => void update($, confirming, c => (c === section ? null : c)).catch(() => {}))
    return
  }
  await update($, confirming, () => null)
  const v = sections(s, await read($, busy))
  for (const r of section === 'project' ? [...v.here, ...v.other] : v.elsewhere) if (r.state === 'running') await stop($, s, r.server!)
}

// ——— Reading command output (pure, tested) ———

export type Proc = { pid: number; ppid: number; elapsedMs: number; rssKb: number; cpu: number; command: string }

// `lsof -Fpcn`: a "p" line per process, then its command ("c") and its addresses ("n", "*:3000").
export function parseListeners(out: string) {
  const map = new Map<number, { command: string; ports: number[] }>()
  let entry: { command: string; ports: number[] } | undefined
  for (const line of out.split('\n')) {
    const value = line.slice(1)
    if (line[0] === 'p') {
      const pid = Number(value)
      entry = map.get(pid) ?? { command: '', ports: [] }
      map.set(pid, entry)
    } else if (line[0] === 'c' && entry) entry.command = value
    else if (line[0] === 'n' && entry) {
      const port = Number(/:(\d+)$/.exec(value)?.[1])
      if (port > 0 && !entry.ports.includes(port)) entry.ports.push(port)
    }
  }
  for (const e of map.values()) e.ports.sort((a, b) => a - b)
  return map
}

// `lsof -a -d cwd -Fn`: each process's working folder.
export function parseCwds(out: string) {
  const map = new Map<number, string>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n' && pid) map.set(pid, line.slice(1))
  }
  return map
}

// `ps -axo pid=,ppid=,etime=,rss=,%cpu=,command=`.
export function parsePs(out: string) {
  const map = new Map<number, Proc>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+([\d.,]+)\s+(.*)$/.exec(line)
    if (!m) continue
    map.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), elapsedMs: elapsed(m[3]!), rssKb: Number(m[4]), cpu: Number(m[5]!.replace(',', '.')), command: m[6]! })
  }
  return map
}

// ps's elapsed time, "[[dd-]hh:]mm:ss", in milliseconds.
export function elapsed(etime: string) {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const seconds = clock!.split(':').reduce((n, part) => n * 60 + Number(part), 0)
  return (Number(days) * 86_400 + seconds) * 1000
}

// `git rev-parse --path-format=absolute --show-toplevel --git-common-dir`, and the branch.
export function toGitInfo(out: string, branch: string): GitInfo | null {
  const [top, common] = out.trim().split('\n')
  if (!top || !common) return null
  const repo = common.replace(/\/$/, '')
  return { top, repo, name: basename(repo.endsWith('/.git') ? repo.slice(0, -5) : repo.replace(/\.git$/, '')), branch }
}

// A dev server runs from one of the person's folders; apps opened from the Finder run from "/" or their bundle.
export const isForeign = (command: string) => FOREIGN.test(command)

export function isDevFolder(cwd: string, home: string) {
  return home !== '' && cwd.startsWith(`${home}/`) && !cwd.startsWith(`${home}/Library/`) && !cwd.includes('.app/')
}

// What started the listener: up through the launchers (npm run dev, sh -c, node) to the first process that is not
// one, such as the person's terminal shell or Claude. Stopping the launcher stops the whole server.
const LAUNCHER = /(^|\/)(node|npm|npx|pnpm|yarn|bun|bunx|deno|uv|poetry|nodemon|tsx|ts-node|next|vite|turbo|concurrently|lerna|nx|python[\d.]*)(\s|$)|(^|\/)(ba|z)?sh -c /
export function launcher(pid: number, procs: Map<number, Proc>) {
  let at = pid
  for (let i = 0; i < 8; i++) {
    const parent = procs.get(procs.get(at)?.ppid ?? 0)
    if (!parent || parent.pid <= 1 || !LAUNCHER.test(parent.command) || FOREIGN.test(parent.command)) break
    at = parent.pid
  }
  return at
}

export function descendants(pid: number, procs: Map<number, Proc>) {
  const out: number[] = []
  const queue = [pid]
  while (queue.length) {
    const at = queue.shift()!
    for (const p of procs.values()) if (p.ppid === at && !out.includes(p.pid)) (out.push(p.pid), queue.push(p.pid))
  }
  return out
}

function ancestors(pid: number, procs: Map<number, Proc>, root: number) {
  const out: number[] = []
  let at = pid
  while (at !== root && out.length < 8) {
    at = procs.get(at)?.ppid ?? root
    out.unshift(at)
  }
  return out
}

// What started a server: the nearest of Claude or a terminal app above its launcher. A login shell ("-zsh") with
// no app found is a terminal too; a launcher whose parent is gone (launchd took it) is detached.
const CLAUDE = /(^|\/)claude(\s|$)|@anthropic-ai\/claude-code/
const TERMINALS: [RegExp, string][] = [
  [/\/Terminal\.app\//, 'Terminal'],
  [/\/iTerm\d?\.app\/|(^|\/)iTerm2(\s|$)/, 'iTerm'],
  [/\/Warp\.app\//, 'Warp'],
  [/\/Ghostty\.app\//i, 'Ghostty'],
  [/\/kitty\.app\/|(^|\/)kitty(\s|$)/, 'kitty'],
  [/\/Alacritty\.app\//, 'Alacritty'],
  [/\/WezTerm\.app\/|(^|\/)wezterm-gui(\s|$)/i, 'WezTerm'],
  [/\/Visual Studio Code\.app\/|(^|\/)Code Helper/, 'VS Code'],
  [/\/Cursor\.app\//, 'Cursor'],
  [/\/Zed\.app\//, 'Zed'],
  [/(^|\/)tmux(:|\s|$)/, 'tmux'],
]
const SHELL = /^(\S*\/)?-?(ba|z|fi|k|da)?sh(\s|$)/
const PS_SELF = /^\/bin\/ps -axo pid=,ppid=/

// The Claude process this mod runs in: above the `ps` it ran to read the table.
export function selfClaude(procs: Map<number, Proc>) {
  const ps = [...procs.values()].find(p => PS_SELF.test(p.command))
  return ps ? nearest(ps.ppid, procs, p => CLAUDE.test(p.command)) : undefined
}

function nearest(pid: number, procs: Map<number, Proc>, test: (p: Proc) => boolean) {
  let at = procs.get(pid)
  for (let i = 0; at && at.pid > 1 && i < 24; i++, at = procs.get(at.ppid)) if (test(at)) return at.pid
  return undefined
}

export function originOf(root: number, procs: Map<number, Proc>, self?: number): Origin {
  const top = procs.get(root)
  if (!top) return { kind: 'unknown' }
  if (top.ppid <= 1) return { kind: 'detached' }
  let isLogin = false
  let at = procs.get(top.ppid)
  for (let i = 0; at && at.pid > 1 && i < 24; i++, at = procs.get(at.ppid)) {
    if (CLAUDE.test(at.command)) {
      if (self === undefined) return { kind: 'claude' }
      if (at.pid !== self) return { kind: 'claude', app: 'another conversation' }
      // The pane runs the entry itself (exec: no shell left above it); Claude's own commands go through a shell.
      return at.pid === top.ppid && !SHELL.test(top.command) ? { kind: 'pane' } : { kind: 'conversation' }
    }
    const app = TERMINALS.find(([re]) => re.test(at!.command))?.[1]
    if (app) return { kind: 'terminal', app }
    if (/^-\S*sh(\s|$)|^login(\s|$)|(^|\/)login -/.test(at.command)) isLogin = true
  }
  return isLogin ? { kind: 'terminal' } : { kind: 'unknown' }
}

// The origin as the row's second line starts.
export function originText(o: Origin) {
  switch (o.kind) {
    case 'pane':
      return 'this pane'
    case 'conversation':
      return 'Claude, this conversation'
    case 'claude':
      return o.app ? `Claude, ${o.app}` : 'Claude'
    case 'terminal':
      return o.app ?? 'Terminal'
    case 'detached':
      return 'detached'
    default:
      return ''
  }
}

// The script a package manager runs ("npm run dev" → dev), from the launch chain: past the options, and past a
// workspace's name (`pnpm --filter web dev`, `yarn workspace web dev`).
const TAKES_VALUE = /^(--filter|-F|--workspace|-w|workspace|--cwd|-C|--dir)$/
const NOT_SCRIPTS = ['exec', 'x', 'dlx', 'install', 'i', 'add', 'create', 'run']
export function scriptName(commands: string[]) {
  for (const c of commands) {
    const m = /(?:^|\/|\s)(?:npm|pnpm|yarn|bun)(?:-cli\.js)?\s+(.*)$/.exec(c)
    if (!m) continue
    const words = m[1]!.split(/\s+/).filter(Boolean)
    const rest: string[] = []
    for (let i = 0; i < words.length; i++) {
      if (TAKES_VALUE.test(words[i]!)) i++
      else if (!words[i]!.startsWith('-')) rest.push(words[i]!)
    }
    const name = rest[0] === 'run' || rest[0] === 'run-script' ? rest[1] : rest[0]
    if (name && /^[\w:.-]+$/.test(name) && !NOT_SCRIPTS.includes(name)) return name
  }
  return undefined
}

// The program a command runs, past its interpreter and flags: "node .bin/vite" → vite, "python3 -m http.server" → http.server.
export function binaryName(command: string) {
  const words = command.split(/\s+/).filter(Boolean)
  const rest = /^(node|python[\d.]*|ruby|bun|deno|php)$/i.test(basename(words[0] ?? '')) ? words.slice(1).filter(w => !w.startsWith('-')) : words
  return basename(rest[0] ?? words[0] ?? 'server')
}

// A short name for what a command serves, the most specific first (Storybook runs on Vite or Webpack).
const KINDS: [RegExp, string][] = [
  [/storybook/, 'Storybook'],
  [/\bnext(\s|$)|next-server|\/next\/dist/, 'Next.js app'],
  [/\bastro\b/, 'Astro site'],
  [/\bnuxt\b/, 'Nuxt app'],
  [/\bremix\b|react-router dev/, 'Remix app'],
  [/\bsvelte-kit\b|sveltekit/, 'SvelteKit app'],
  [/\bvite\b/, 'Vite app'],
  [/webpack/, 'Webpack dev server'],
  [/\bexpo\b|metro/, 'Expo app'],
  [/wrangler/, 'Cloudflare worker'],
  [/uvicorn|fastapi/, 'FastAPI app'],
  [/flask/, 'Flask app'],
  [/manage\.py\s+runserver/, 'Django app'],
  [/http\.server/, 'Python file server'],
  [/\brails\b|puma/, 'Rails app'],
  [/http-server|\bserve\b/, 'Static server'],
  [/\bphp\b/, 'PHP server'],
  [/\bbun\b/, 'Bun server'],
  [/\bdeno\b/, 'Deno server'],
  [/\bnode\b|nodemon|tsx|ts-node/, 'Node server'],
  [/python/, 'Python server'],
]
export function describe(commands: string) {
  return KINDS.find(([re]) => re.test(commands))?.[1] ?? ''
}

const SERVES = [/\bnext (dev|start)\b/, /\bvite(\s+(dev|serve|preview)|\s+--|\s*$)/, /\b(astro|nuxt|remix) (dev|preview)\b/, /storybook dev|start-storybook/, /webpack (serve|-dev-server)|webpack-dev-server/, /\bhttp-server\b|\bserve\b/, /\bnodemon\b|\buvicorn\b|flask run|runserver|\brails s(erver)?\b|wrangler dev|expo start/]

export function isServerScript(name: string, command: string) {
  if (/(^|:)(build|test|lint|format|typecheck|clean|deploy|release|prepare|postinstall)($|:)/.test(name)) return false
  return /^(dev|start|serve|preview|storybook)($|:)/.test(name) || SERVES.some(re => re.test(command))
}

export function portOf(command: string) {
  const m = /(?:--port|-p)[ =](\d{2,5})\b/.exec(command) ?? /\bPORT=(\d{2,5})\b/.exec(command)
  return m ? Number(m[1]) : undefined
}

// The name is quoted: it goes through the shell, and a repository's package.json is not the person's own.
export function packageScripts(pkg: any, dir: string, pm: string): Launchable[] {
  const scripts: Record<string, unknown> = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}
  return Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && isServerScript(entry[0], entry[1]))
    .map(([name, command]) => ({ id: `${dir}#${name}`, name, script: name, command, run: `${pm} run ${quote(name)}`, cwd: dir, source: 'package.json', port: portOf(command), description: describe(command) }))
}

// .claude/launch.json: `{ configurations: [{ name, runtimeExecutable, runtimeArgs, port }] }`; an entry with no
// command (it attaches to a server already running) has nothing to launch.
export function launchConfigs(json: any, top: string): Launchable[] {
  const list: any[] = Array.isArray(json?.configurations) ? json.configurations : []
  return list
    .filter(c => c && typeof c.name === 'string' && typeof c.runtimeExecutable === 'string')
    .map(c => {
      const args: string[] = Array.isArray(c.runtimeArgs) ? c.runtimeArgs.map(String) : []
      const command = [c.runtimeExecutable, ...args].join(' ')
      const isPm = /^(npm|pnpm|yarn|bun)$/.test(c.runtimeExecutable)
      const cwd = typeof c.cwd === 'string' ? (c.cwd.startsWith('/') ? c.cwd : `${top}/${c.cwd}`) : top
      return {
        id: `${top}#launch:${c.name}`,
        name: c.name,
        script: isPm ? (args[0] === 'run' ? args[1] : args[0]) : undefined,
        command,
        run: [c.runtimeExecutable, ...args].map(quote).join(' '),
        cwd,
        source: 'launch.json' as const,
        port: typeof c.port === 'number' ? c.port : portOf(command),
        description: describe(command),
      }
    })
}

const quote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)
const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

// ——— Figures ———

export function duration(ms: number) {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`
  if (min < 60) return `${min}m`
  if (min < 1440) return `${Math.floor(min / 60)}h`
  return `${Math.floor(min / 1440)}d`
}

export function memory(kb: number) {
  const mb = kb / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

// Cuts `text` to what fits in `px` at the pane's font (or a font `charWidth` wide), with an ellipsis.
export function fit(text: string, px: number, charWidth = CHAR_WIDTH) {
  return cut(text, Math.floor(px / charWidth))
}

// Cuts `text` to `room` characters, with an ellipsis.
const cut = (text: string, room: number) => (room <= 0 ? '' : text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`)

// Breaks `text` into lines that fit in `px`, between words.
export function wrap(text: string, px: number, charWidth = CHAR_WIDTH) {
  const room = Math.max(10, Math.floor(px / charWidth))
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > room) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

// ——— The desktop drawing, in CSS pixels ———
// The engine gives columns, not pixels: drawings are sized at an estimate of a column's width. A pane is opened to
// be read and has room: it uses the panel scale of the mods' design (16 px titles, 13 px text, 12 px secondary).

const PX_PER_COLUMN = 8.4
const FONT = 13
const SMALL = 12 // descriptions, the second line, captions
const TITLE_FONT = 16
const CHAR_WIDTH = 7.3 // an estimate of a character's width at FONT
const SMALL_WIDTH = 6.7 // the same at SMALL
const MONO_WIDTH = 7.3 // the port's monospaced digits, at SMALL
const ROW_H = 44 // a server: two lines
const LINE1 = 18 // their baselines
const LINE2 = 36
const HEAD_H = 34 // a section's title line
const HEAD_BASE = 22
const CAPTION_H = 24
const CAPTION_BASE = 16
const IND_W = 22 // the state, left of the name
const ICON = 14 // the pane's stroked icons
const TAG_H = 20 // the port
const TAG_CELLS = 8 // ":65535" at most, right-aligned
const BTN_W = 24
const BTN_H = 22
const BUTTON_BOX = 3 // a button's cells
const BUTTON_CELLS = 3 * BUTTON_BOX + 3 // three buttons, each a cell from the last
const TEXT = '#8b8b90'
const SOFT = '#c4c4c9'
const BRIGHT = '#e8e8ea'
const TAG_GROUND = '#2e2e32' // under the port of what runs
const OFF = '#6e6e73' // the empty dot of what does not run
const DARK = '#5d5d62' // the rest of a row that does not run: it steps back, what runs stands out
const DIM = '#5d6370' // a port nothing listens on yet
const BUTTON_GROUND = '#2a2a2d'
const RULE = '#3a3a3e'
const TIP = { name: '#b9b9be', dim: '#7d7d83', card: '#262629', border: '#3d3f45' } // the tooltips: soft grey text; in a pane, on a card of their own
const EMPTY_GROUND = '#232326' // under an empty state's note
const FONTS = "-apple-system, 'SF Pro Text', system-ui, sans-serif"
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace"

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const svgOpen = (width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONTS}" font-size="${FONT}">`

const PLAY = (color: string) => `<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" fill="${color}"/>`
const SQUARE = (color: string) => `<rect x="5" y="5" width="14" height="14" rx="2.5" fill="${color}"/>`

// A git branch, `size` px, in the text's grey, its top at `y`.
function branchGlyph(x: number, y: number, size: number) {
  return `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="${TEXT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="18" r="2"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 8v8M18 8c0 5-12 4-12 8"/></g>`
}

// The state, on a 16 grid. Running: a faint ring and, inside it, a grey wave drifting right, one wavelength every
// 5 s, `begin` s into it so that every row's wave moves in step; `id` keeps the clips apart when several glyphs
// share one drawing. Ready: the empty dot alone. Starting: an arc turning fast. Stopping: the dot, grey and still.
export function stateGlyph(state: Row['state'], begin = 0, id = 'w') {
  const at = `begin="${begin.toFixed(2)}s" repeatCount="indefinite"`
  const turn = (ms: number) => `<animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="${ms / 1000}s" ${at}/>`
  const crest = 'q2 -2.6 4 0t4 0'
  return {
    running: `<defs><clipPath id="${id}"><circle cx="8" cy="8" r="6.2"/></clipPath></defs><circle cx="8" cy="8" r="6" fill="none" stroke="${RULE}" stroke-width="0.8"/><g clip-path="url(#${id})"><path d="M-16 8${crest.repeat(10)}" fill="none" stroke="${SOFT}" stroke-width="1.2" stroke-linecap="round"><animateTransform attributeName="transform" type="translate" from="0 0" to="8 0" dur="${WAVE_MS / 1000}s" ${at}/></path></g>`,
    ready: `<circle cx="8" cy="8" r="2.6" fill="none" stroke="${OFF}" stroke-width="1.3"/>`,
    starting: `<circle cx="8" cy="8" r="2.6" fill="none" stroke="${SOFT}" stroke-width="1.3"/><circle cx="8" cy="8" r="6" fill="none" stroke="${SOFT}" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="9 29">${turn(1200)}</circle>`,
    stopping: `<circle cx="8" cy="8" r="2.6" fill="${OFF}"/>`,
  }[state]
}

// The state in a pane's row, level with the name.
export function indicatorSvg(state: Row['state'], begin = 0) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${IND_W}" height="${ROW_H}" viewBox="0 0 ${IND_W} ${ROW_H}"><g transform="translate(1 ${LINE1 - 12.5})">${stateGlyph(state, begin)}</g></svg>`
}

// A server's two lines: its name and what it is; then its branch, uptime, memory and CPU, or what a launch runs.
// A row that runs is bright; one that does not steps back a shade, down to its button.
export function rowSvg(row: Row, width: number) {
  const isOn = row.state === 'running' || row.state === 'stopping'
  const name = fit(row.name, width * 0.6)
  const room = width - name.length * CHAR_WIDTH - 8
  const description = room > 40 ? fit(row.description, room, SMALL_WIDTH) : ''
  const first = `<text x="0" y="${LINE1}" xml:space="preserve"><tspan fill="${isOn ? BRIGHT : TEXT}">${esc(name)}</tspan>${description ? `<tspan dx="8" fill="${isOn ? TEXT : DARK}" font-size="${SMALL}">${esc(description)}</tspan>` : ''}</text>`
  return `${svgOpen(width, ROW_H)}${first}<text x="0" y="${LINE2}" font-size="${SMALL}" xml:space="preserve">${metaSpans(row.meta, width, isOn ? TEXT : DARK)}</text></svg>`
}

// The second line's parts, " · " between them, cut where the width ends; a forgotten uptime in orange.
function metaSpans(parts: Part[], width: number, color = TEXT) {
  let room = Math.floor(width / SMALL_WIDTH)
  const spans: string[] = []
  for (const [i, p] of parts.entries()) {
    const sep = i ? ' · ' : ''
    if (room - sep.length < 2) break
    const t = cut(p.text, room - sep.length)
    room -= sep.length + t.length
    spans.push(`${sep ? `<tspan fill="${color}">${sep}</tspan>` : ''}<tspan fill="${p.isWarm ? ORANGE : color}"${p.isWarm ? ' font-weight="600"' : ''}>${esc(t)}</tspan>`)
  }
  return spans.join('')
}

// The port: light on a faint ground while a server listens on it, dim for the one a launch would take, orange
// when another server holds it.
export function portSvg(row: Row) {
  const label = `:${row.port}`
  const width = Math.round(label.length * MONO_WIDTH + 12)
  const live = row.state === 'running'
  const warm = row.note !== undefined
  const ground = live ? `<rect width="${width}" height="${TAG_H}" rx="3" fill="${TAG_GROUND}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${TAG_H}" viewBox="0 0 ${width} ${TAG_H}">${ground}<text x="${width / 2}" y="14" text-anchor="middle" fill="${warm ? ORANGE : live ? SOFT : DIM}" font-family="${MONO}" font-size="${SMALL}"${warm ? ' font-weight="600"' : ''}>${esc(label)}</text></svg>`
}

// A row's button: a filled stop on a faint ground, the two opens as strokes on it (a window for Claude's browser,
// an arrow out of a box for the default one); the play of a row that does not run is a grey outline, no ground.
export function buttonSvg(kind: Action['kind']) {
  const size = kind === 'start' || kind === 'stop' ? 11 : 13
  const stroke = (d: string) => `<path d="${d}" fill="none" stroke="${SOFT}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`
  const icon = kind === 'start' ? PLAY(TEXT) : kind === 'stop' ? SQUARE(SOFT) : stroke(kind === 'preview' ? 'M3 5h18v14H3zM3 9h18' : 'M13 5h6v6M19 5l-8 8M17 14v5H5V7h5')
  const ground = kind === 'start' ? `<rect x="0.5" y="0.5" width="${BTN_W - 1}" height="${BTN_H - 1}" rx="5" fill="none" stroke="${RULE}"/>` : `<rect width="${BTN_W}" height="${BTN_H}" rx="5" fill="${BUTTON_GROUND}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BTN_W}" height="${BTN_H}" viewBox="0 0 ${BTN_W} ${BTN_H}">${ground}<g transform="translate(${(BTN_W - size) / 2} ${(BTN_H - size) / 2}) scale(${size / 24})">${icon}</g></svg>`
}

// A section's title, and beside it the project or the count: one text, so the app sets the gap, not an estimate.
export function sectionSvg(title: string, detail: string, width: number) {
  const room = Math.max(0, width - title.length * CHAR_WIDTH * (TITLE_FONT / FONT) - 10)
  const side = detail ? `<tspan dx="10" fill="${TEXT}" font-size="${SMALL}">${esc(fit(detail, room, SMALL_WIDTH))}</tspan>` : ''
  return `${svgOpen(width, HEAD_H)}<text x="0" y="${HEAD_BASE}" xml:space="preserve"><tspan fill="${SOFT}" font-size="${TITLE_FONT}">${esc(title)}</tspan>${side}</text></svg>`
}

// A section's quick action ("Launch all", "Stop all"): a small filled icon and the word, orange while it asks to confirm.
export function wordSvg(label: string, width: number, glyph?: 'start' | 'stop', isWarm = false) {
  const color = isWarm ? ORANGE : SOFT
  const icon = glyph ? `<g transform="translate(0 ${HEAD_BASE - 9}) scale(${10 / 24})">${(glyph === 'start' ? PLAY : SQUARE)(color)}</g>` : ''
  return `${svgOpen(width, HEAD_H)}${icon}<text x="${glyph ? 15 : 0}" y="${HEAD_BASE}" fill="${color}" font-size="${SMALL}"${isWarm ? ' font-weight="600"' : ''}>${esc(label)}</text></svg>`
}

// The conversation's branch, over its servers.
export function branchSvg(branch: string, width: number) {
  const name = fit(branch, Math.max(60, width - 150), SMALL_WIDTH)
  return `${svgOpen(width, CAPTION_H)}${branchGlyph(0, CAPTION_BASE - 10, 12)}<text x="18" y="${CAPTION_BASE}" font-size="${SMALL}" xml:space="preserve"><tspan fill="${SOFT}">${esc(name)}</tspan><tspan fill="${TEXT}"> · this conversation</tspan></text></svg>`
}

// A caption ("Other branches", with the branch glyph) or a line of help, in secondary text.
export function captionSvg(caption: string, width: number, withBranch = false) {
  const x = withBranch ? 18 : 0
  return `${svgOpen(width, CAPTION_H)}${withBranch ? branchGlyph(0, CAPTION_BASE - 10, 12) : ''}<text x="${x}" y="${CAPTION_BASE}" fill="${TEXT}" font-size="${SMALL}" xml:space="preserve">${esc(fit(caption, width - x, SMALL_WIDTH))}</text></svg>`
}

// A group's head, running elsewhere, in the style of the conversation's branch line: the project in the brighter
// grey, then its branch with the branch glyph and the folder it sits in, all at the small size, set apart from the
// group above by a little room.
export function groupSvg(g: Group, width: number, isSpaced = false) {
  const top = isSpaced ? 10 : 0
  const base = top + CAPTION_BASE
  const name = fit(g.name, width * 0.5, SMALL_WIDTH)
  const parts = [`<text x="0" y="${base}" font-size="${SMALL}" xml:space="preserve"><tspan fill="${SOFT}">${esc(name)}</tspan><tspan fill="${TEXT}"> · </tspan></text>`]
  let x = (name.length + 3) * SMALL_WIDTH
  if (g.branch) {
    parts.push(branchGlyph(x, base - 10, 12))
    x += 18
  }
  const rest = fit([g.branch, g.folder].filter(Boolean).join(' · '), width - x, SMALL_WIDTH)
  parts.push(`<text x="${x}" y="${base}" fill="${TEXT}" font-size="${SMALL}" xml:space="preserve">${esc(rest)}</text>`)
  return `${svgOpen(width, top + CAPTION_H)}${parts.join('')}</svg>`
}

// The thin line between the two sections, with room under it before the next title.
export function ruleSvg(width: number) {
  return `${svgOpen(width, 40)}<rect x="0" y="14" width="${width}" height="1" fill="${RULE}"/></svg>`
}

// An empty state: its sentences close together on a faint grey ground, so they read as one note.
export function emptySvg(sentences: string[], width: number) {
  const pad = 12
  const lines = sentences.flatMap(t => wrap(t, width - 2 * pad, SMALL_WIDTH))
  const height = 2 * pad + lines.length * 18 - 4
  const text = lines.map((line, i) => `<text x="${pad}" y="${pad + 12 + i * 18}" fill="${TEXT}" font-size="${SMALL}" xml:space="preserve">${esc(line)}</text>`).join('')
  return `${svgOpen(width, height + 8)}<rect x="0" y="0" width="${width}" height="${height}" rx="6" fill="${EMPTY_GROUND}"/>${text}</svg>`
}

// The title line's asks, ICON px, stroked in the text's grey: a plus, and a magnifier.
export function paneIcon(kind: 'add' | 'find') {
  const d = { add: 'M12 5v14M5 12h14', find: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13zM15.5 15.5L20 20' }[kind]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 24 24"><path d="${d}" fill="none" stroke="${TEXT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}
