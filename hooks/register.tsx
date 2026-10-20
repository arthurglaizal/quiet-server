// Quiet Server: the dev servers of this project, the ones that run and the ones ready to launch, and what runs elsewhere.
//   Port Menu, tied to the conversation. The status line keeps the count: this branch's servers that run out of all
//   it runs or can launch, and what runs elsewhere. The pane, which /quiet-server opens, has two sections, one under
//   the other. This project: what runs on the conversation's branch and what
//   it can launch (package.json scripts, .claude/launch.json), then the same project's other branches, one group each:
//   main open, the others folded under a chevron, those without a worktree on one line. Running elsewhere: every other dev server. Everything stays grey; a wave moves in what runs;
//   orange marks a server forgotten for a day, or a port another server already holds.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Launchable, Origin, Project, Section, Server, Snapshot, Worktree } from '../types'

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
const GLYPH = { running: '◉', ready: '○', starting: '◌', stopping: '◉', copy: '⧉', open: '↗', stop: '■', start: '▶' } as const
const TOGGLE_GLYPH = '⊙' // the footer's button: an eye seen from the front (the eye character is drawn as a color emoji)
// What the two "ask Claude" buttons put in the prompt box, for the person to complete or send.
const ASK = {
  add: 'Add a dev server to this project\'s .claude/launch.json (name, runtimeExecutable, runtimeArgs, port): ',
  find: 'Look through this project (package.json scripts, docker-compose, Makefile, READMEs, subfolders) for dev servers that .claude/launch.json does not list yet, and add the useful ones to it.',
} as const
const EMPTY = ['Nothing to run here yet.', 'Dev scripts from package.json and .claude/launch.json show up here.']
const HERE_TIP = 'This conversation works on this branch'
const MAX_TREES = 20 // the other worktrees read, at most
const LOOSE_MAX = 12 // the branches without a worktree listed, at most

// Held by the host, so the pane survives a hot reload of this file.
const snapshot = atom({ plugin: 'quiet-server', key: 'snapshot' } as const, null as Snapshot | null)
const isStatusHidden = atom({ plugin: 'quiet-server', key: 'isStatusHidden' } as const, false)
const busy = atom({ plugin: 'quiet-server', key: 'busy' } as const, [] as string[]) // rows starting or stopping, by key
const confirming = atom({ plugin: 'quiet-server', key: 'confirming' } as const, null as Section | null) // "Stop all" pressed once, there
const opened = atom({ plugin: 'quiet-server', key: 'opened' } as const, {} as Record<string, boolean>) // a branch group folded or unfolded by hand, by repository and branch

// The module's own: a reload starts them over, and ends the servers this session launched with their loops.
const launched = new Map<string, AsyncGenerator<unknown, unknown>>() // by launchable id
const gitCache = new Map<string, { at: number; info: GitInfo | null }>()
const repoCache = new Map<string, { at: number; value: RepoBranches }>() // by the conversation's working tree
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
    const folds = await $.store.get('opened').catch(() => undefined)
    if (folds && typeof folds === 'object') await update($, opened, () => folds as Record<string, boolean>)
    void refresh($).catch(() => {})
    $.clock.every(TICK, () => void tick($).catch(() => {}))
    return r
  })

  on('command.run', { command: 'quiet-server' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'status') {
      const hidden = await toggleStatus($)
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

  // In the prompt's footer, beside the mode labels: a button that opens or closes the pane (the status line, being
  // text, cannot be pressed). The desktop draws its native button there and no drawing inside it: the button holds
  // one glyph, a window with its side panel. The desktop only: the terminal has /quiet-server.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.surface === 'terminal' || (await read($, isStatusHidden))) return rest // the pane's switch hides it with the count
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center">
        <Button key="pane-toggle" plain dimColor onPress={() => void togglePane($).catch(() => {})}>
          {TOGGLE_GLYPH}
        </Button>
        {rest && <Box marginLeft={2}>{rest}</Box>}
      </Box>
    )
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
    // The branches, each a group under a chevron: this conversation's and main open, one where something runs too;
    // the others folded. A fold pressed by hand is kept, for this repository.
    const folds = await read($, opened)
    const foldKey = (id: string) => `${s.project.repo}|${id}`
    const isOpenAt = (id: string, fallback: boolean) => folds[foldKey(id)] ?? fallback
    const fold = (id: string, isOpen: boolean) => () => void toggleOpen($, foldKey(id), isOpen).catch(() => {})
    const launchList = (list: Launchable[]) => (isDemo ? demoPress($) : () => void startList($, list))
    const hereOpen = !s.project.branch || isOpenAt('@here', true)
    const hereHead: Head | undefined = s.project.branch ? { key: 'here', name: s.project.branch, icon: s.project.branch === s.trunk ? 'anchor' : 'branch', isOpen: hereOpen, isHere: true, toggle: fold('@here', hereOpen) } : undefined
    const groupOpen = (g: BranchGroup) => isOpenAt(g.id, g.isTrunk || g.rows.some(r => r.server !== undefined))
    const headOf = (g: BranchGroup): Head => {
      const isOpen = groupOpen(g)
      const batch = g.top ? launchBatch(g.rows) : []
      return { key: g.key, name: g.branch, icon: g.isDetached ? 'commit' : g.isTrunk ? 'anchor' : 'branch', isOpen, summary: summaryOf(g), isSpaced: true, launch: batch.length ? { names: batch.map(l => l.name), press: launchList(batch) } : undefined, toggle: fold(g.id, isOpen) }
    }
    const looseOpen = isOpenAt('@loose', false)
    const looseHead: Head = { key: 'loose', name: `${v.loose.length} more branch${v.loose.length === 1 ? '' : 'es'}`, icon: 'branch', isOpen: looseOpen, summary: 'no worktree', isSpaced: true, toggle: fold('@loose', looseOpen) }
    const makeTree = (branch: string) => (isDemo ? demoPress($) : () => void askWorktree($, branch))
    // The two that ask Claude: add a server, or look for ones to add. Both fill the prompt; the person sends it.
    const asks = [
      { key: 'ask-add', icon: 'add' as const, tip: 'Ask Claude to add a server', label: 'add', press: () => void ask($, 'add') },
      { key: 'ask-find', icon: 'find' as const, tip: 'Ask Claude to look for servers to add', label: 'find', press: () => void ask($, 'find') },
    ]
    // The switch for the count in the status line, after the asks: a window with its strip along the bottom, filled
    // while the count shows there.
    const isCountShown = !(await read($, isStatusHidden))
    const countSwitch = { key: 'pane-status', tip: isCountShown ? 'Hide the count and button under the prompt' : 'Show the count and button under the prompt', label: isCountShown ? 'hide count' : 'show count', press: () => void toggleStatus($).catch(() => {}) }
    const elsewhereCount = v.elsewhere.length ? String(v.elsewhere.length) : ''

    // The surfaces with a vector element draw small text as SVG; the terminal draws the same rows in characters.
    const Svg = (e.surface === 'terminal' ? undefined : ($.ui.resolve(e) as any).Svg) as ((props: { source: string; alt: string; width?: number; height?: number }) => any) | undefined
    if (Svg) {
      const drawn = Math.round(inner * PX_PER_COLUMN)
      const textWidth = Math.max(160, drawn - IND_W - Math.round((TAG_CELLS + BUTTON_CELLS) * PX_PER_COLUMN) - 16)
      keepPhases(v, await $.clock.now())
      // A tip under its button, ending at the button's right edge, on a card of its own as quiet-model's pane draws
      // them (the app draws none in a pane). The tree is turned over at the end so a tip covers the rows below.
      const tip = (text: string, side: 'left' | 'right' = 'right') => (
        <Box position="absolute" top={1} {...(side === 'left' ? { left: 0 } : { right: 0 })} width={text.length + 4} display="none" hover={{ display: 'flex' }} backgroundColor={TIP.card} borderStyle="round" borderColor={TIP.border} paddingX={1}>
          <Text color={TIP.name}>{text}</Text>
        </Box>
      )
      // A row's button: a filled icon on a faint ground, an empty button over the whole box, and a short tooltip.
      const iconButton = (b: { key: string; svg: string; tip: string; press: () => void }) => (
        <Box key={`${b.key}-box`} width={BUTTON_BOX} height={1} marginLeft={1} justifyContent="center" alignItems="center">
          <Svg source={b.svg} alt={b.tip} width={BTN_W} height={BTN_H} />
          <Box position="absolute" top={0} left={0} width={BUTTON_BOX} height={1} justifyContent="center">
            <Button key={b.key} plain onPress={b.press}>
              {press(BUTTON_BOX)}
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
                {press(width)}
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
          <Box position="absolute" top={0} left={0} width={2} height={1} justifyContent="center">
            <Button key={b.key} plain onPress={b.press}>
              {press(2)}
            </Button>
          </Box>
          {tip(b.tip)}
        </Box>
      )
      // After "This project": the two asks.
      const extras = [...asks.map(a => smallButton({ key: a.key, svg: paneIcon(a.icon), tip: a.tip, press: a.press })), smallButton({ ...countSwitch, svg: statusIcon(isCountShown) })]
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
      // keeps moving; the port is a label beside its buttons.
      const rowView = (row: Row) => {
        return (
          <Box key={row.key} flexDirection="row" alignItems="center">
            <Svg source={indicatorSvg(row.state, phases.get(row.key))} alt={row.state} width={IND_W} height={ROW_H} />
            <Box flexShrink={1}>
              <Svg source={rowSvg(row, textWidth)} alt={rowAlt(row)} />
            </Box>
            <Box flexGrow={1} />
            {/* The port, a label: the row's own button copies the address. */}
            <Box width={TAG_CELLS} height={1} flexDirection="row" justifyContent="flex-end" alignItems="center">
              {row.port !== undefined && <Svg source={portSvg(row)} alt={`port ${row.port}`} />}
            </Box>
            <Box width={BUTTON_CELLS} flexDirection="row" justifyContent="flex-end">
              {actions(row).map(a => iconButton({ key: `${row.key}:${a.kind}`, svg: buttonSvg(a.kind), tip: a.tip, press: a.press }))}
            </Box>
          </Box>
        )
      }
      // A branch's head: the chevron, its glyph, its name, then "here" or what it holds. The whole head folds the
      // group; "here" explains itself on hover; a group with servers to launch has its own Launch.
      const branchHeader = (br: Head) => {
        const drawing = branchHeadSvg({ ...br, isSpaced: false }, drawn - (br.launch ? 100 : 0))
        const cells = Math.ceil(drawing.width / PX_PER_COLUMN)
        // The room above a group is a drawing of its own: the empty button over the head then covers the name alone.
        return (
          <Box key={`${br.key}-head`} flexDirection="column">
            {br.isSpaced && <Svg source={spaceSvg(8)} alt="" />}
            <Box flexDirection="row" alignItems="center">
              <Box flexShrink={1}>
                <Svg source={drawing.svg} alt={[br.name, br.isHere ? 'this conversation' : br.summary, br.isOpen ? 'open' : 'folded'].filter(Boolean).join(', ')} />
                <Box position="absolute" top={0} left={0} width={cells} height={1}>
                  <Button key={`toggle:${br.key}`} plain onPress={br.toggle}>
                    {press(cells)}
                  </Button>
                </Box>
                {drawing.tag && (
                  <Box position="absolute" top={0} left={Math.floor(drawing.tag.x / PX_PER_COLUMN)} width={Math.ceil(drawing.tag.width / PX_PER_COLUMN)} height={1}>
                    {tip(HERE_TIP, 'left')}
                  </Box>
                )}
              </Box>
              <Box flexGrow={1} />
              {br.launch && wordButton({ key: `group-launch:${br.key}`, label: 'Launch', tip: `Launch ${br.launch.names.join(', ')}`, glyph: 'start', press: br.launch.press })}
            </Box>
          </Box>
        )
      }
      const worktreeButton = (branch: string) => wordButton({ key: `worktree:${branch}`, label: 'Create worktree', tip: `Ask Claude to create a worktree for ${branch}`, press: makeTree(branch) })
      const note = (key: string, text: string, branch?: string) => (
        <Box key={key} flexDirection="row" alignItems="center">
          <Svg source={captionSvg(text, drawn - 160, false, IND_W)} alt={text} />
          <Box flexGrow={1} />
          {branch !== undefined && worktreeButton(branch)}
        </Box>
      )
      const groupBody = (g: BranchGroup) =>
        !g.top ? [note(`${g.key}:none`, 'No folder for this branch yet', g.branch)] : g.rows.length === 0 ? [note(`${g.key}:empty`, 'Nothing to launch on this branch')] : g.rows.map(rowView)
      return overTheNext(
        <Box flexDirection="column" paddingX={1}>
          {header('This project', '', bulk.project, extras)}
          <Svg source={projectSvg(s.project.name, drawn)} alt={s.project.name} />
          {hereHead && branchHeader(hereHead)}
          {hereOpen && v.here.length === 0 && <Svg source={emptySvg(EMPTY, drawn, POTTED_CACTUS)} alt={EMPTY.join(' ')} />}
          {hereOpen && v.here.map(rowView)}
          {v.branches.map(g => (
            <Box key={g.key} flexDirection="column">
              {branchHeader(headOf(g))}
              {groupOpen(g) && groupBody(g)}
            </Box>
          ))}
          {v.loose.length > 0 && (
            <Box key="loose" flexDirection="column">
              {branchHeader(looseHead)}
              {looseOpen && v.loose.slice(0, LOOSE_MAX).map(b => (
                <Box key={`loose:${b}`} flexDirection="row" alignItems="center">
                  <Svg source={captionSvg(b, textWidth, true, IND_W)} alt={b} />
                  <Box flexGrow={1} />
                  {worktreeButton(b)}
                </Box>
              ))}
              {looseOpen && v.loose.length > LOOSE_MAX && note('loose:more', `and ${v.loose.length - LOOSE_MAX} more`)}
            </Box>
          )}
          <Svg source={ruleSvg(drawn)} alt="Divider" />
          {header('Running elsewhere', elsewhereCount, bulk.elsewhere)}
          {v.elsewhere.length === 0 && <Svg source={emptySvg(['Nothing else is running.'], drawn, NIGHT)} alt="Nothing else is running." />}
          {groups(v.elsewhere).map((g, i) => (
            <Box key={g.key} flexDirection="column">
              <Svg source={groupSvg(g, drawn, i > 0)} alt={[g.name, g.folder].join(', ')} />
              {g.trees.map(t => (
                <Box key={t.key} flexDirection="column">
                  {t.branch && <Svg source={captionSvg(t.branch, drawn, true)} alt={`branch ${t.branch}`} />}
                  {t.rows.map(rowView)}
                </Box>
              ))}
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
        {withAsks && (
          <Box key={`${countSwitch.key}-box`} marginLeft={2}>
            <Button key={countSwitch.key} plain dimColor onPress={countSwitch.press}>
              {countSwitch.label}
            </Button>
          </Box>
        )}
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
                <Button key={`${row.key}:port`} plain onPress={copyPort(row)}>
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
    // A branch's head: a chevron to press, its name, and what it holds or "this conversation".
    const termHead = (br: Head) => (
      <Box key={`${br.key}-head`} flexDirection="row" marginTop={br.isSpaced ? 1 : 0}>
        <Button key={`toggle:${br.key}`} plain dimColor onPress={br.toggle}>
          {br.isOpen ? '▾' : '▸'}
        </Button>
        <Box marginLeft={1} flexShrink={1}>
          <Text dimColor={!br.isHere} wrap="truncate-end">
            {br.isHere ? `${br.name} · this conversation` : br.name}
          </Text>
        </Box>
        {!br.isHere && br.summary && <Text dimColor wrap="truncate-end">{` · ${br.summary}`}</Text>}
        <Box flexGrow={1} />
        {br.launch && (
          <Box marginLeft={2}>
            <Button key={`group-launch:${br.key}`} plain dimColor onPress={br.launch.press}>
              {`${GLYPH.start} launch`}
            </Button>
          </Box>
        )}
      </Box>
    )
    const termNote = (key: string, text: string, branch?: string) => (
      <Box key={key} flexDirection="row">
        <Box width={2} flexShrink={0} />
        <Text dimColor wrap="truncate-end">{text}</Text>
        <Box flexGrow={1} />
        {branch !== undefined && (
          <Button key={`worktree:${branch}`} plain dimColor onPress={makeTree(branch)}>
            create worktree
          </Button>
        )}
      </Box>
    )
    const termBody = (g: BranchGroup) =>
      !g.top ? [termNote(`${g.key}:none`, 'No folder for this branch yet', g.branch)] : g.rows.length === 0 ? [termNote(`${g.key}:empty`, 'Nothing to launch on this branch')] : g.rows.map(termRow)
    return (
      <Box flexDirection="column" paddingX={1}>
        {termHeader('This project', '', bulk.project, true)}
        <Text dimColor wrap="truncate-end">{s.project.name}</Text>
        {hereHead && termHead(hereHead)}
        {hereOpen && v.here.length === 0 && EMPTY.map(t => <Text key={`empty:${t}`} dimColor>{t}</Text>)}
        {hereOpen && v.here.map(termRow)}
        {v.branches.map(g => (
          <Box key={g.key} flexDirection="column">
            {termHead(headOf(g))}
            {groupOpen(g) && termBody(g)}
          </Box>
        ))}
        {v.loose.length > 0 && (
          <Box key="loose" flexDirection="column">
            {termHead(looseHead)}
            {looseOpen && v.loose.slice(0, LOOSE_MAX).map(b => termNote(`loose:${b}`, b, b))}
            {looseOpen && v.loose.length > LOOSE_MAX && termNote('loose:more', `and ${v.loose.length - LOOSE_MAX} more`)}
          </Box>
        )}
        <Box marginTop={1} marginBottom={1}>
          <Text dimColor>{'─'.repeat(inner)}</Text>
        </Box>
        {termHeader('Running elsewhere', elsewhereCount, bulk.elsewhere)}
        {v.elsewhere.length === 0 && <Text dimColor>Nothing else is running.</Text>}
        {groups(v.elsewhere).map((g, i) => (
          <Box key={g.key} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
            <Text wrap="truncate-end">
              <Text>{g.name}</Text>
              <Text dimColor>{`  ${g.folder}`}</Text>
            </Text>
            {g.trees.map(t => (
              <Box key={t.key} flexDirection="column">
                {t.branch && <Text dimColor wrap="truncate-end">{`⑂ ${t.branch}`}</Text>}
                {t.rows.map(termRow)}
              </Box>
            ))}
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

type Action = { kind: 'copy' | 'open' | 'stop' | 'start'; tip: string; press: () => void }

// A running server: copy its address, open it in the default browser, or stop it.
function rowActions($: EngineInterface, s: Snapshot, row: Row, surface: string): Action[] {
  return isDemo ? realActions($, s, row, surface).map(a => ({ ...a, press: demoPress($) })) : realActions($, s, row, surface)
}

const demoPress = ($: EngineInterface) => () => void $.ui.toast('Demo servers: nothing to act on. /quiet-server demo brings the real ones back')

function realActions($: EngineInterface, s: Snapshot, row: Row, surface: string): Action[] {
  if (row.state === 'starting' || row.state === 'stopping') return []
  if (row.state === 'ready') {
    if (!row.launchable) return []
    const l = row.launchable
    return [{ kind: 'start', tip: 'Launch', press: () => void start($, l) }]
  }
  const url = row.port ? `http://localhost:${row.port}` : undefined
  const out: Action[] = []
  if (url && surface === 'desktop') out.push({ kind: 'copy', tip: 'Copy address', press: () => void copy($, url, surface) }) // the terminal's port copies it
  if (url) out.push({ kind: 'open', tip: 'Open in browser', press: () => void open($, url) })
  out.push({ kind: 'stop', tip: 'Stop', press: () => void stop($, s, row.server!) })
  return out
}

type Bulk = { key: string; label: string; tip: string; glyph?: 'start' | 'stop'; isWarm?: boolean; press: () => void }

// A branch group's head, as both surfaces draw it.
export type Head = {
  key: string
  name: string
  icon: 'branch' | 'anchor' | 'commit' // a branch; main, the anchor; a worktree on no branch
  isOpen: boolean
  isHere?: boolean // the conversation's branch: tagged "here"
  summary?: string // "1 running · 3 to launch"
  isSpaced?: boolean
  launch?: { names: string[]; press: () => void }
  toggle: () => void
}

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
// launched from the pane, a worktree on main running one of two, another on a fix with two to launch, two branches
// with no worktree, and four elsewhere in three projects, started from a terminal,
// another conversation, or left detached and forgotten for days.
export function demoSnapshot(): Snapshot {
  const home = '/Users/me/code'
  const top = `${home}/atelier-web`
  const repo = `${top}/.git`
  const launchableAt = (dir: string, name: string, command: string, port: number): Launchable => ({ id: `${dir}#${name}`, name, script: name, command, run: `npm run ${name}`, cwd: dir, source: 'package.json', port, description: describe(command) })
  const launchable = (name: string, command: string, port: number) => launchableAt(top, name, command, port)
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
  const cartTree = `${home}/atelier-web-cart`
  return {
    project: { cwd: top, top, repo, name: 'atelier-web', branch: 'feat/checkout' },
    launchables: [launchable('dev', 'next dev -p 3001', 3001), launchable('storybook', 'storybook dev -p 6006', 6006), launchable('preview', 'next start -p 4173', 4173)],
    worktrees: [
      { top: mainTree, branch: 'main', isDetached: false, launchables: [launchableAt(mainTree, 'dev', 'next dev', 3000), launchableAt(mainTree, 'storybook', 'storybook dev -p 6008', 6008)] },
      { top: cartTree, branch: 'fix/cart-total', isDetached: false, launchables: [launchableAt(cartTree, 'dev', 'next dev -p 3002', 3002), launchableAt(cartTree, 'storybook', 'storybook dev -p 6009', 6009)] },
    ],
    branches: ['design/tokens', 'feat/checkout', 'fix/cart-total', 'main', 'spike/edge-cache'],
    trunk: 'main',
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

// Another branch of the project: a worktree with its rows, or main with no worktree yet (no `top`).
export type BranchGroup = { key: string; id: string; branch: string; top?: string; isTrunk: boolean; isDetached: boolean; rows: Row[] }

// `other`: every branch group's rows, for "Stop all" and the waves. `loose`: the branches with no worktree.
export type Sections = { here: Row[]; branches: BranchGroup[]; loose: string[]; other: Row[]; elsewhere: Row[] }

// This branch: what runs, then what it can launch. Other branches: the same project's other worktrees, main first,
// each with what runs and what it can launch, then the branches with no worktree. Elsewhere: every other server,
// by project and port.
export function sections(s: Snapshot, pending: string[] = []): Sections {
  const { project, launchables, servers } = s
  const byPort = (a: Server, b: Server) => (a.ports[0] ?? 0) - (b.ports[0] ?? 0)
  // Without git, the tree is the folder itself: a server run from a subfolder of it is still this project's.
  const hasGit = (x: { top: string; repo: string }) => x.repo !== x.top
  const isMine = (x: Server) => x.top === project.top || (!hasGit(x) && !hasGit(project) && (x.cwd === project.top || x.cwd.startsWith(`${project.top}/`)))
  const here = treeRows(launchables, servers.filter(isMine).sort(byPort), project, servers, pending, 'here')
  // The other worktrees git lists, and any a server runs from that it did not.
  const theirs = servers.filter(x => x.repo === project.repo && !isMine(x)).sort(byPort)
  const trees = new Map<string, Worktree>()
  for (const w of s.worktrees ?? []) if (w.top !== project.top) trees.set(w.top, w)
  for (const sv of theirs) if (!trees.has(sv.top)) trees.set(sv.top, { top: sv.top, branch: sv.branch, isDetached: sv.branch === 'detached', launchables: [] })
  const trunk = s.trunk ?? ''
  const branches: BranchGroup[] = [...trees.values()].map(w => ({
    key: `branch:${w.top}`,
    id: w.isDetached ? w.top : w.branch,
    branch: w.isDetached ? basename(w.top) : w.branch,
    top: w.top,
    isTrunk: !w.isDetached && w.branch === trunk && trunk !== '',
    isDetached: w.isDetached,
    rows: treeRows(w.launchables, theirs.filter(x => x.top === w.top), w, servers, pending, 'other'),
  }))
  const checkedOut = new Set([project.branch, ...[...trees.values()].map(w => w.branch)])
  if (trunk && !checkedOut.has(trunk)) branches.push({ key: 'branch:trunk', id: trunk, branch: trunk, isTrunk: true, isDetached: false, rows: [] })
  branches.sort((a, b) => Number(b.isTrunk) - Number(a.isTrunk) || Number(a.isDetached) - Number(b.isDetached) || a.branch.localeCompare(b.branch))
  const elsewhere = servers.filter(x => x.repo !== project.repo && !isMine(x)).sort((a, b) => a.projectName.localeCompare(b.projectName) || byPort(a, b))
  return {
    here,
    branches,
    loose: (s.branches ?? []).filter(b => !checkedOut.has(b) && b !== trunk),
    other: branches.flatMap(g => g.rows),
    elsewhere: elsewhere.map(sv => serverRow(sv, 'elsewhere', undefined, pending)),
  }
}

// A working tree's rows: what runs from it, then what it can launch. A server claims one launchable: the one it
// carries the name, script or port of, else the one whose command runs the same program ("next" for `next dev`).
// Each launchable is claimed once: `next dev` leaves `start` ready.
function treeRows(launchables: Launchable[], svs: Server[], place: { top: string; branch: string }, servers: Server[], pending: string[], section: Row['section']): Row[] {
  const claimed = new Set<string>()
  const claim = (sv: Server) => {
    const l = launchables.find(l => !claimed.has(l.id) && matches(l, sv)) ?? launchables.find(l => !claimed.has(l.id) && binaryName(l.command) === sv.name)
    if (l) claimed.add(l.id)
    return l
  }
  const running = svs.map(sv => serverRow(sv, section, claim(sv), pending))
  return [...running, ...launchables.filter(l => !claimed.has(l.id)).map(l => readyRow(l, place, servers, pending, section))]
}

// What a folded group's head says it holds: "1 running · 3 to launch", "no worktree".
export function summaryOf(g: BranchGroup) {
  if (!g.top) return 'no worktree'
  const running = g.rows.filter(r => r.server).length
  const ready = g.rows.length - running
  const parts = [...(g.isDetached ? ['detached'] : []), ...(running ? [`${running} running`] : []), ...(ready ? [`${ready} to launch`] : [])]
  return parts.join(' · ') || 'nothing to launch'
}

// The count, one line of text in the status line: "0/0 here", what runs on this branch against all it runs or could
// launch, then "1 elsewhere", a wide space between the two. The app already writes "quiet-server" before it.
export function statusText(s: Snapshot) {
  const { here, elsewhere } = sections(s)
  return `${here.filter(r => r.server).length}/${here.length} here\u2003${elsewhere.length} elsewhere`
}

// A launchable is running when a server of its working tree carries its name, its script or its port.
export function matches(l: Launchable, sv: Server) {
  return sv.name === l.name || (l.script !== undefined && sv.name === l.script) || (l.port !== undefined && sv.ports.includes(l.port))
}

// A server goes by its script ("dev", then "Next.js app"); its second line starts with what started it. Its branch,
// or its project and branch elsewhere, head its group: the line does not repeat them.
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
      : [...(origin ? [{ text: origin }] : []), { text: duration(sv.uptimeMs), isWarm: isForgotten }, { text: memory(sv.rssKb) }, { text: `${Math.round(sv.cpu)}% CPU` }],
    isForgotten,
    server: sv,
    launchable: l,
  }
}

function readyRow(l: Launchable, place: { top: string; branch: string }, servers: Server[], pending: string[], section: Row['section'] = 'here'): Row {
  const key = `launch:${l.id}`
  const isStarting = pending.includes(key)
  const holder = l.port === undefined ? undefined : servers.find(sv => sv.ports.includes(l.port!))
  const note = holder ? `used by ${holder.top === place.top ? holder.name : holder.branch || holder.projectName}` : undefined
  return {
    key,
    section,
    state: isStarting ? 'starting' : 'ready',
    name: l.name,
    description: l.description,
    branch: place.branch,
    port: l.port,
    meta: isStarting ? [{ text: 'Starting…' }] : [...(note ? [{ text: `port ${l.port} ${note}`, isWarm: true }] : []), { text: l.run }],
    isForgotten: false,
    note,
    launchable: l,
  }
}

// Running elsewhere, by project: one group per repository, headed by its name and the folder it sits in, then a
// line per working tree it runs from, headed by its branch, in the order the rows come (by project, then port).
export type Tree = { key: string; branch: string; rows: Row[] }
export type Group = { key: string; name: string; folder: string; trees: Tree[] }
export function groups(rows: Row[]): Group[] {
  const out = new Map<string, Group>()
  for (const r of rows) {
    const sv = r.server!
    const home = sv.repo.endsWith('/.git') ? sv.repo.slice(0, -5) : sv.top // the main worktree, where the repository sits
    const g = out.get(sv.repo) ?? { key: `group:${sv.repo}`, name: sv.projectName, folder: folderOf(home), trees: [] }
    const t = g.trees.find(x => x.key === `tree:${sv.top}`) ?? (g.trees.push({ key: `tree:${sv.top}`, branch: sv.branch, rows: [] }), g.trees.at(-1)!)
    t.rows.push(r)
    out.set(sv.repo, g)
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
    const [launchables, servers, repo] = await Promise.all([findLaunchables($, project), scanServers($, home, now), repoBranches($, project, now)])
    const fresh: Snapshot = { project, launchables, servers, ...repo }
    await update($, snapshot, () => fresh)
    // A launch is done once its server listens, a stop once its process is gone.
    const v = sections(fresh)
    const runningKeys = new Set([...v.here, ...v.other].filter(r => r.launchable && r.server).map(r => `launch:${r.launchable!.id}`))
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
// /quiet-server status and the pane's switch: the choice is kept across sessions.
async function toggleStatus($: EngineInterface) {
  const hidden = await update($, isStatusHidden, wasHidden => !wasHidden)
  await $.store.set('isStatusHidden', hidden).catch(() => {})
  await showStatus($)
  return hidden
}

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

type RepoBranches = { worktrees: Worktree[]; branches: string[]; trunk: string }

// The repository's other worktrees with what each can launch, its local branches, and its default branch: what
// origin's HEAD names, else main, else master. Read again after GIT_TTL.
async function repoBranches($: EngineInterface, p: Project, now: number): Promise<RepoBranches> {
  if (p.repo === p.top) return { worktrees: [], branches: [], trunk: '' }
  const kept = repoCache.get(p.top)
  if (kept && now - kept.at < GIT_TTL) return kept.value
  const [list, refs, head] = await Promise.all([
    run($, [BIN.git, '-C', p.top, 'worktree', 'list', '--porcelain']),
    run($, [BIN.git, '-C', p.top, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    run($, [BIN.git, '-C', p.top, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']),
  ])
  const branches = refs.exitCode === 0 ? refs.stdout.split('\n').map(b => b.trim()).filter(Boolean) : []
  const worktrees: Worktree[] = []
  for (const w of parseWorktrees(list.exitCode === 0 ? list.stdout : '').filter(w => w.top !== p.top).slice(0, MAX_TREES)) {
    worktrees.push({ ...w, launchables: await findLaunchables($, { cwd: w.top, top: w.top, repo: p.repo, name: p.name, branch: w.branch }) })
  }
  const value = { worktrees, branches, trunk: trunkOf(branches, head.exitCode === 0 ? head.stdout.trim() : '') }
  repoCache.set(p.top, { at: now, value })
  return value
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

async function mark($: EngineInterface, key: string, isBusy: boolean) {
  await update($, busy, list => (isBusy ? [...new Set([...list, key])] : list.filter(k => k !== key)))
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
  const all = [...s.launchables, ...(s.worktrees ?? []).flatMap(w => w.launchables)]
  const own = all.find(l => (l.cwd === sv.top || l.cwd.startsWith(`${sv.top}/`)) && matches(l, sv) && launched.has(l.id))
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

// "Create worktree": a request in the prompt box, for the person to send. Claude creates the folder; the pane lists it.
async function askWorktree($: EngineInterface, branch: string) {
  const text = `Create a git worktree for the branch ${branch} in .claude/worktrees/, and install its dependencies if it needs any, so its dev servers can run beside this one.`
  const done = await $.prompt.fill({ text, mode: 'replace' }).catch(() => undefined)
  void $.ui.toast(done?.isFilled ? 'Prompt filled: send it to create the worktree' : 'Could not fill the prompt')
}

// A branch group folded or unfolded by hand: kept across sessions.
async function toggleOpen($: EngineInterface, key: string, wasOpen: boolean) {
  const folds = await update($, opened, o => ({ ...o, [key]: !wasOpen }))
  await $.store.set('opened', folds).catch(() => {})
}

async function startList($: EngineInterface, list: Launchable[]) {
  for (const l of list) await start($, l)
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

// `git worktree list --porcelain`: a block per worktree, its path, then its branch or "detached". A bare repository
// and a worktree whose folder is gone ("prunable") are left out.
export function parseWorktrees(out: string): Omit<Worktree, 'launchables'>[] {
  const list: Omit<Worktree, 'launchables'>[] = []
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split('\n')
    const top = lines.find(l => l.startsWith('worktree '))?.slice(9)
    if (!top || lines.some(l => l === 'bare' || l.startsWith('prunable'))) continue
    const ref = lines.find(l => l.startsWith('branch '))?.slice(7)
    list.push({ top, branch: ref ? ref.replace(/^refs\/heads\//, '') : 'detached', isDetached: !ref })
  }
  return list
}

// The default branch: the one origin's HEAD names ("origin/main"), else main, else master, else none.
export function trunkOf(branches: string[], originHead: string) {
  const named = originHead.replace(/^origin\//, '')
  if (named) return named
  return ['main', 'master'].find(b => branches.includes(b)) ?? ''
}

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

// A script that serves: named so (dev, start, serve, preview, storybook, and their dev:web kind), or running a known
// server. Not one that builds or checks, nor one that only controls a server (dev:stop, `astro dev status`).
const CONTROLS = /(^|:)(stop|status|kill|restart|logs?|ps|open|types|dry-run)($|:)/
const CONTROL_COMMAND = /\s(stop|status|kill|restart|logs?)(\s|$)/
export function isServerScript(name: string, command: string) {
  if (/(^|:)(build|test|lint|format|typecheck|clean|deploy|release|prepare|postinstall)($|:)/.test(name)) return false
  if (CONTROLS.test(name) || CONTROL_COMMAND.test(command)) return false
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
const NAME_WIDTH = 6.1 // a branch's name at SMALL, lower case and slashes
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
const BUTTON_BOX = 4 // a button's cells: its 24 px drawing, and a cell to spare so the press area can take a fourth space
// What fills an empty button laid over a drawing `cells` wide: no-break spaces, the only space the desktop does not
// cut with an ellipsis drawn over the button. It cuts any label wider than the box less the button's own padding
// (PRESS_PAD); a no-break space is about PRESS_SPACE px. Up to four cells, a space to a cell.
const PRESS_PAD = 14
const PRESS_SPACE = 3.6
const press = (cells: number) => '\u00A0'.repeat(cells <= 4 ? cells : Math.floor((cells * PX_PER_COLUMN - PRESS_PAD) / PRESS_SPACE))
const BUTTON_CELLS = 3 * BUTTON_BOX + 3 // three buttons, each a cell from the last
const TEXT = '#8b8b90'
const SOFT = '#c4c4c9'
const BRIGHT = '#e8e8ea'
const TAG_LINE = '#3a3a3e' // around the port of what runs
const OFF = '#6e6e73' // the empty dot of what does not run
const DARK = '#5d5d62' // the rest of a row that does not run: it steps back, what runs stands out
const DIM = '#5d6370' // a port nothing listens on yet
const BUTTON_GROUND = '#2a2a2d'
const RULE = '#3a3a3e'
const TIP = { name: '#b9b9be', dim: '#7d7d83', card: '#262629', border: '#3d3f45' } // the tooltips: soft grey text; in a pane, on a card of their own
const EMPTY_GROUND = '#1f1f21' // under an empty state's note: a shade off the pane, barely there
const EMPTY_ART = '#4a4a4f' // its drawing, a step under the text's grey
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

// The port, a label rather than a button: light inside a thin outline while a server listens on it, dim for the one
// a launch would take, orange when another server holds it.
export function portSvg(row: Row) {
  const label = `:${row.port}`
  const width = Math.round(label.length * MONO_WIDTH + 12)
  const live = row.state === 'running'
  const warm = row.note !== undefined
  const ground = live ? `<rect x="0.5" y="0.5" width="${width - 1}" height="${TAG_H - 1}" rx="3" fill="none" stroke="${TAG_LINE}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${TAG_H}" viewBox="0 0 ${width} ${TAG_H}">${ground}<text x="${width / 2}" y="14" text-anchor="middle" fill="${warm ? ORANGE : live ? SOFT : DIM}" font-family="${MONO}" font-size="${SMALL}"${warm ? ' font-weight="600"' : ''}>${esc(label)}</text></svg>`
}

// A row's button, on a faint ground: a filled play or stop, the copy and the open as strokes (two sheets for the
// address, an arrow out of a box for the default browser).
export function buttonSvg(kind: Action['kind']) {
  const size = kind === 'start' || kind === 'stop' ? 11 : 13
  const stroke = (d: string) => `<path d="${d}" fill="none" stroke="${SOFT}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`
  const icon = kind === 'start' ? PLAY(SOFT) : kind === 'stop' ? SQUARE(SOFT) : stroke(kind === 'copy' ? 'M9 9h10v10H9zM15 9V5H5v10h4' : 'M13 5h6v6M19 5l-8 8M17 14v5H5V7h5')
  const ground = `<rect width="${BTN_W}" height="${BTN_H}" rx="5" fill="${BUTTON_GROUND}"/>`
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

// Stroked icons on a 24 grid (Tabler's, MIT): the chevrons, main's anchor, a worktree on no branch, and the pin.
const ICONS = {
  open: 'M6 9l6 6l6 -6',
  folded: 'M9 6l6 6l-6 6',
  anchor: 'M12 9v12M4 13a8 8 0 0 0 16 0M21 13h-2M5 13H3M9 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
  commit: 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M12 3v6M12 15v6',
  pin: 'M9 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0M17.657 16.657l-4.243 4.243a2 2 0 0 1 -2.827 0l-4.244 -4.243a8 8 0 1 1 11.314 0z',
} as const
const strokeIcon = (d: string, x: number, y: number, size: number, color: string, width = 2) =>
  `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></g>`
const HERE_GROUND = '#262629' // the "here" tag

// A branch group's head: a chevron, the branch glyph (main's anchor, a commit for a worktree on no branch), the
// name, then the "here" tag, a pin lit inside it, or what the group holds. As wide as what it draws, so the empty
// button over it folds the group from anywhere on it; `tag` says where "here" sits, for its tooltip.
export function branchHeadSvg(br: Pick<Head, 'name' | 'icon' | 'isOpen' | 'isHere' | 'summary' | 'isSpaced'>, maxWidth: number) {
  const top = br.isSpaced ? 8 : 0
  const base = top + CAPTION_BASE
  const parts = [strokeIcon(br.isOpen ? ICONS.open : ICONS.folded, 0, base - 10, 12, OFF, 2.4)]
  parts.push(br.icon === 'branch' ? branchGlyph(16, base - 10, 12) : strokeIcon(ICONS[br.icon], 16, base - 10, 12, TEXT))
  const x = 34
  const name = fit(br.name, Math.max(60, maxWidth - x - 140), SMALL_WIDTH)
  parts.push(`<text x="${x}" y="${base}" fill="${br.isHere ? BRIGHT : SOFT}" font-size="${SMALL}" xml:space="preserve">${esc(name)}</text>`)
  let end = x + name.length * SMALL_WIDTH
  let tag: { x: number; width: number } | undefined
  if (br.isHere) {
    tag = { x: x + name.length * NAME_WIDTH + 8, width: 52 } // a branch name is mostly lower case: narrower than the estimate
    parts.push(
      `<rect x="${tag.x}" y="${base - 12}" width="${tag.width}" height="16" rx="4" fill="${HERE_GROUND}"/>`,
      strokeIcon(ICONS.pin, tag.x + 6, base - 9.5, 11, BRIGHT),
      `<text x="${tag.x + 21}" y="${base}" fill="${TEXT}" font-size="11">here</text>`,
    )
    end = tag.x + tag.width
  } else if (br.summary) {
    const rest = fit(` · ${br.summary}`, maxWidth - end - 4, SMALL_WIDTH)
    parts.push(`<text x="${end}" y="${base}" fill="${TEXT}" font-size="${SMALL}" xml:space="preserve">${esc(rest)}</text>`)
    end += rest.length * SMALL_WIDTH
  }
  const width = Math.ceil(Math.min(maxWidth, end + 4))
  return { svg: `${svgOpen(width, top + CAPTION_H)}${parts.join('')}</svg>`, width, tag }
}

// Room between two groups, `height` px.
export function spaceSvg(height: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="${height}" viewBox="0 0 1 ${height}"></svg>`
}

// The project's name, under "This project": the brighter grey, at the small size, a little room below it.
export function projectSvg(name: string, width: number) {
  return `${svgOpen(width, CAPTION_H)}<text x="0" y="${CAPTION_BASE - 4}" fill="${SOFT}" font-size="${SMALL}" xml:space="preserve">${esc(fit(name, width, SMALL_WIDTH))}</text></svg>`
}

// A caption or a line of help in secondary text, from `indent` px; with the branch glyph, a branch with no worktree.
export function captionSvg(caption: string, width: number, withBranch = false, indent = 0) {
  const x = indent + (withBranch ? 18 : 0)
  return `${svgOpen(width, CAPTION_H)}${withBranch ? branchGlyph(indent, CAPTION_BASE - 10, 12) : ''}<text x="${x}" y="${CAPTION_BASE}" fill="${TEXT}" font-size="${SMALL}" xml:space="preserve">${esc(fit(caption, width - x, SMALL_WIDTH))}</text></svg>`
}

// A group's head, running elsewhere: the project in the brighter grey, then the folder it sits in, one text at the
// small size so the app sets the gap, set apart from the group above by a little room. Its branches follow, each on
// a line of its own.
export function groupSvg(g: Group, width: number, isSpaced = false) {
  const top = isSpaced ? 10 : 0
  const name = fit(g.name, width * 0.6, SMALL_WIDTH)
  const folder = fit(` · ${g.folder}`, width - name.length * SMALL_WIDTH, SMALL_WIDTH)
  return `${svgOpen(width, top + CAPTION_H)}<text x="0" y="${top + CAPTION_BASE}" font-size="${SMALL}" xml:space="preserve"><tspan fill="${SOFT}">${esc(name)}</tspan><tspan fill="${TEXT}">${esc(folder)}</tspan></text></svg>`
}

// The thin line between the two sections, with room under it before the next title.
export function ruleSvg(width: number) {
  return `${svgOpen(width, 40)}<rect x="0" y="14" width="${width}" height="1" fill="${RULE}"/></svg>`
}

// An empty state: a small drawing, then its sentences close together beside it, on a faint grey ground, so they
// read as one note.
export function emptySvg(sentences: string[], width: number, art: string) {
  const pad = 12
  const box = { w: 64, h: 51 } // the drawing, drawn at 4/5 of its 80 × 64 grid
  const x = pad + box.w + 14
  const lines = sentences.flatMap(t => wrap(t, width - x - pad, SMALL_WIDTH))
  const textHeight = lines.length * 18 - 4
  const height = Math.max(box.h, textHeight) + 2 * pad
  const top = (height - textHeight) / 2
  const text = lines.map((line, i) => `<text x="${x}" y="${top + 12 + i * 18}" fill="${TEXT}" font-size="${SMALL}" xml:space="preserve">${esc(line)}</text>`).join('')
  const drawing = `<g transform="translate(${pad} ${(height - box.h) / 2}) scale(0.8)" fill="none" stroke="${EMPTY_ART}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${art}</g>`
  return `${svgOpen(width, height + 8)}<rect x="0" y="0" width="${width}" height="${height}" rx="6" fill="${EMPTY_GROUND}"/>${drawing}${text}</svg>`
}

// The empty states' drawings, on an 80 × 64 grid. This project: a small, squat cactus in a wide pot, nothing
// planted yet, drawn 1.2 times its size from the pot's foot, its stroke thinned to match the night scene's.
const POTTED_CACTUS = [
  '<g transform="translate(41 57) scale(1.2) translate(-41 -54)" stroke-width="1.33">',
  `<path d="M28 44h26l-2 10H30z" fill="${EMPTY_ART}" fill-opacity="0.1"/>`,
  '<path d="M38 44V30a3 3 0 0 1 6 0v14M38 38h-3a2.5 2.5 0 0 1-2.5-2.5V32M44 36h3a2.5 2.5 0 0 0 2.5-2.5V30"/>',
  '</g>',
].join('')

// Running elsewhere: two cacti, a tall one and a small one, under a moon and two stars, a desert at night.
const NIGHT = [
  '<path d="M8 52h64"/>',
  '<path d="M64 10a6 6 0 1 0 4 9 5 5 0 0 1-4-9z"/><path d="M48 12v3M46.5 13.5h3M14 14v2M13 15h2"/>',
  `<path d="M26 52V20a3.5 3.5 0 0 1 7 0v32M26 38h-4a3 3 0 0 1-3-3v-6M33 33h4a3 3 0 0 0 3-3v-5" fill="${EMPTY_ART}" fill-opacity="0.1"/>`,
  '<path d="M50 52V36a2.5 2.5 0 0 1 5 0v16M55 44h3a2 2 0 0 0 2-2v-3"/>',
].join('')

// The title line's asks, ICON px, stroked in the text's grey: a plus, and a magnifier.
export function paneIcon(kind: 'add' | 'find') {
  const d = { add: 'M12 5v14M5 12h14', find: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13zM15.5 15.5L20 20' }[kind]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 24 24"><path d="${d}" fill="none" stroke="${TEXT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

// The pane's switch for the count, ICON px: a window with its strip along the bottom, the strip filled while the
// count shows in the status line.
export function statusIcon(isShown: boolean) {
  const strip = isShown ? `<rect x="5" y="14" width="14" height="4" rx="1" fill="${SOFT}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 24 24">${strip}<path d="M4 5h16v14H4zM4 13h16" fill="none" stroke="${TEXT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}
