import { describe, expect, test } from 'claude-code/testing'

import {
  binaryName,
  demoSnapshot,
  describe as kindOf,
  duration,
  elapsed,
  emptySvg,
  fit,
  folderOf,
  groups,
  groupSvg,
  isDevFolder,
  isForeign,
  isServerScript,
  indicatorSvg,
  launchBatch,
  launchConfigs,
  launcher,
  memory,
  originOf,
  originText,
  packageScripts,
  parseCwds,
  parseListeners,
  parsePs,
  portOf,
  portSvg,
  rowSvg,
  scriptName,
  sections,
  selfClaude,
  statusText,
  toGitInfo,
  wrap,
} from '../hooks/register'

const HOME = '/Users/me'
const SHOP = `${HOME}/code/shop` // the conversation's project, on feat/login
const SHOP_MAIN = `${HOME}/code/shop-main` // a worktree of it, on main
const BLOG = `${HOME}/code/blog` // another project

const LSOF = ['p100', 'cnode', 'f20', 'n*:3000', 'f21', 'n[::1]:3000', 'p200', 'cnode', 'n127.0.0.1:3001', 'p300', 'cnode', 'n*:5173', 'p663', 'cControlCenter', 'n*:7000', 'p900', 'cclaude', 'n127.0.0.1:4545'].join('\n')
const CWDS = ['p100', 'fcwd', `n${SHOP}`, 'p200', 'fcwd', `n${SHOP_MAIN}`, 'p300', 'fcwd', `n${BLOG}`, 'p663', 'fcwd', 'n/'].join('\n')
const PS = [
  '    1     0 10-00:00:00  1000  0.0 /sbin/launchd',
  '   50     1 02:00:00  9000  0.0 -zsh',
  '   99    50    12:00 40960  0.5 npm run dev',
  `  100    99    12:00 286720  3.5 node ${SHOP}/node_modules/.bin/next dev`,
  `  101   100    11:59 20480  0.0 node ${SHOP}/node_modules/next/dist/server/lib/worker.js`,
  '  199    50 02:00:00 51200  0.0 npm run dev',
  `  200   199 02:00:00 368640  1.0 node ${SHOP_MAIN}/node_modules/.bin/next dev`,
  `  300    50 3-01:00:00 798720  0.0 node ${BLOG}/node_modules/.bin/vite`,
  '  663     1 4-00:00:00 72048  0.0 /System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter',
].join('\n')
const GIT: Record<string, [string, string, string]> = {
  [SHOP]: [SHOP, `${SHOP}/.git`, 'feat/login'],
  [SHOP_MAIN]: [SHOP_MAIN, `${SHOP}/.git`, 'main'],
  [BLOG]: [BLOG, `${BLOG}/.git`, 'main'],
}
const FILES: Record<string, string> = {
  [`${SHOP}/package.json`]: JSON.stringify({ scripts: { dev: 'next dev', build: 'next build', storybook: 'storybook dev -p 6006', lint: 'eslint .' } }),
  [`${SHOP}/.claude/launch.json`]: JSON.stringify({ version: '0.0.1', configurations: [{ name: 'api', runtimeExecutable: 'uvicorn', runtimeArgs: ['main:app', '--port', '8000'], port: 8000 }] }),
}

// Stands for the engine and the machine beneath the mod.
function engine(on: any) {
  const ran: string[][] = []
  const statuses: (string | undefined)[] = []
  const opened: string[] = []
  const browsed: unknown[] = []
  const filled: string[] = []
  const done = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.now() }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: SHOP }))
  on('env.get', (_$: any, e: any) => ({ value: ({ HOME, SHELL: '/bin/zsh' } as Record<string, string>)[e.name] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_$: any, e: any) => {
    if (e.path in FILES) return { value: FILES[e.path] }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('ui.status', (_$: any, e: any) => (statuses.push(e.text), { value: undefined }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'focus' })) // the mode labels Claude Code draws in the footer
  on('ui.panes', () => ({ value: [] }))
  on('prompt.fill', (_$: any, e: any) => (filled.push(e.text), { isFilled: true, text: e.text, cursor: e.text.length }))
  on('mcp.call', (_$: any, e: any) => (browsed.push([e.server, e.tool, e.args]), { value: { content: [], isError: false } }))
  on('ui.open', (_$: any, e: any) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = [...e.argv]
    ran.push(argv)
    if (argv[0] === '/usr/sbin/lsof') return done(argv.includes('-iTCP') ? LSOF : CWDS)
    if (argv[0] === '/bin/ps') return done(PS)
    if (argv[0] === '/usr/bin/git') {
      const info = GIT[argv[2]!]
      if (!info) return done('', 128)
      return argv.includes('symbolic-ref') ? done(`${info[2]}\n`) : done(`${info[0]}\n${info[1]}\n`)
    }
    return done('')
  })
  return { ran, statuses, opened, browsed, filled }
}

const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 30)) // the first read runs in the background
const PANE = { component: 'Pane', requestId: 'servers', props: { title: 'Servers', isFocused: false, bodyColumns: 150, placement: 'inline', rows: 30 } }

function snapshotFixture() {
  const procs = parsePs(PS)
  const server = (pid: number, root: number, cwd: string, ports: number[], name: string, branch: string, repo: string, projectName: string) => ({
    pid,
    pids: [root],
    name,
    description: kindOf(procs.get(pid)!.command),
    ports,
    cwd,
    top: cwd,
    repo,
    projectName,
    branch,
    uptimeMs: procs.get(root)!.elapsedMs,
    rssKb: procs.get(root)!.rssKb,
    cpu: 1,
    origin: originOf(root, procs),
  })
  return {
    project: { cwd: SHOP, top: SHOP, repo: `${SHOP}/.git`, name: 'shop', branch: 'feat/login' },
    launchables: [...launchConfigs(JSON.parse(FILES[`${SHOP}/.claude/launch.json`]!), SHOP), ...packageScripts(JSON.parse(FILES[`${SHOP}/package.json`]!), SHOP, 'npm')],
    servers: [
      server(100, 99, SHOP, [3000], 'dev', 'feat/login', `${SHOP}/.git`, 'shop'),
      server(200, 199, SHOP_MAIN, [3001], 'dev', 'main', `${SHOP}/.git`, 'shop'),
      server(300, 300, BLOG, [5173], 'vite', 'main', `${BLOG}/.git`, 'blog'),
    ],
  }
}

describe('quiet-server', () => {
  test('reads lsof, ps and git output', () => {
    const listening = parseListeners(LSOF)
    expect(listening.get(100)).toEqual({ command: 'node', ports: [3000] }) // IPv4 and IPv6 on one port: one port
    expect(listening.get(663)?.ports).toEqual([7000])
    expect(parseCwds(CWDS).get(200)).toBe(SHOP_MAIN)

    const procs = parsePs(PS)
    expect(procs.get(100)).toMatchObject({ ppid: 99, rssKb: 286720, cpu: 3.5 })
    expect(parsePs('  7  1  00:05  100  0,5 node a.js').get(7)?.cpu).toBe(0.5) // a French locale's decimal comma
    expect(elapsed('12:00')).toBe(720_000)
    expect(elapsed('02:00:00')).toBe(7_200_000)
    expect(elapsed('3-01:00:00')).toBe((3 * 86_400 + 3600) * 1000)

    expect(toGitInfo(`${SHOP_MAIN}\n${SHOP}/.git\n`, 'main')).toEqual({ top: SHOP_MAIN, repo: `${SHOP}/.git`, name: 'shop', branch: 'main' }) // a worktree is named after its repository
    expect(toGitInfo('', 'main')).toBeNull()

    expect(isDevFolder(SHOP, HOME)).toBe(true)
    expect(isDevFolder('/', HOME)).toBe(false) // apps opened from the Finder
    expect(isDevFolder(`${HOME}/Library/Application Support/x`, HOME)).toBe(false)
    expect(isDevFolder('/Applications/Utilities/LogiPluginService.app/x', HOME)).toBe(false)
    expect(isForeign('/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python -m http.server')).toBe(false) // python3, not an app
    expect(isForeign('/Users/me/Library/Application Support/Claude/claude-code/2.1.299/x/claude.app/Contents/MacOS/claude')).toBe(true)
    expect(isForeign('/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper')).toBe(true)
  })

  test('finds what launched a server, and names it', () => {
    const procs = parsePs(PS)
    expect(launcher(100, procs)).toBe(99) // up to npm run dev, not the terminal's shell
    expect(launcher(300, procs)).toBe(300) // vite run straight from the shell
    const mono = parsePs(PS + '\n  400    50 00:10 30000  0.0 node /x/node_modules/.bin/turbo run dev\n  401   400 00:10 20000  0.0 npm run dev\n  402   401 00:09 90000  1.0 node /x/node_modules/.bin/vite')
    expect(launcher(402, mono)).toBe(400) // up to turbo: stopping the server stops the runner too
    expect(scriptName(['npm run dev', 'node .bin/next dev'])).toBe('dev')
    expect(scriptName(['pnpm storybook'])).toBe('storybook')
    expect(scriptName(['npm exec vite'])).toBeUndefined()
    expect(scriptName(['pnpm --filter web dev'])).toBe('dev') // past a workspace's name
    expect(scriptName(['yarn workspace web dev'])).toBe('dev')
    expect(scriptName(['npm run dev --workspace=web -w api'])).toBe('dev')
    expect(binaryName(`node ${BLOG}/node_modules/.bin/vite --host`)).toBe('vite')
    expect(binaryName('python3 -m http.server 8000')).toBe('http.server')
    expect(binaryName('/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python -m http.server')).toBe('http.server') // macOS's own python3
    expect(kindOf('npm run dev\nnode .bin/next dev')).toBe('Next.js app')
    expect(kindOf('storybook dev -p 6006')).toBe('Storybook') // before Vite and Webpack
    expect(kindOf('uvicorn main:app')).toBe('FastAPI app')
    expect(kindOf('something else')).toBe('')
  })

  test('picks the scripts that serve, and the launch.json entries', () => {
    expect(isServerScript('dev', 'next dev')).toBe(true)
    expect(isServerScript('build', 'next build')).toBe(false)
    expect(isServerScript('web', 'vite')).toBe(true)
    expect(isServerScript('bundle', 'vite build')).toBe(false)
    expect(isServerScript('lint', 'eslint .')).toBe(false)
    expect(portOf('storybook dev -p 6006')).toBe(6006)
    expect(portOf('PORT=4000 node server.js')).toBe(4000)
    expect(portOf('next dev')).toBeUndefined()

    const scripts = packageScripts(JSON.parse(FILES[`${SHOP}/package.json`]!), SHOP, 'pnpm')
    expect(scripts.map(l => l.name)).toEqual(['dev', 'storybook'])
    expect(scripts[0]).toMatchObject({ run: 'pnpm run dev', description: 'Next.js app', source: 'package.json' })
    expect(packageScripts({ scripts: { 'dev; rm -rf ~': 'vite' } }, SHOP, 'npm')[0]?.run).toBe("npm run 'dev; rm -rf ~'") // the name goes through the shell: quoted
    expect(scripts[1]?.port).toBe(6006)

    const configs = launchConfigs({ configurations: [{ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 3000 }, { name: 'attach', url: 'http://localhost:9000' }] }, SHOP)
    expect(configs.map(c => c.name)).toEqual(['web']) // an entry with no command has nothing to launch
    expect(configs[0]).toMatchObject({ script: 'dev', port: 3000, run: 'npm run dev', source: 'launch.json' })
  })

  test('sorts the servers into the two sections, and counts them', () => {
    const s = snapshotFixture()
    const v = sections(s)
    expect(v.here.map(r => [r.name, r.state, r.port])).toEqual([['dev', 'running', 3000], ['api', 'ready', 8000], ['storybook', 'ready', 6006]])
    expect(v.here[0]!.description).toBe('Next.js app')
    expect(v.here[0]!.meta.map(p => p.text)).toEqual(['Terminal', '12m', '40 MB', '1% CPU']) // what started it; this branch: no need to name it
    expect(v.here[2]!.meta.map(p => p.text)).toEqual(['npm run storybook'])
    expect(v.other.map(r => [r.name, r.meta[1]!.text])).toEqual([['dev', 'main']]) // another worktree of the same repository
    expect(v.elsewhere.map(r => [r.server!.projectName, r.name, r.description])).toEqual([['blog', 'vite', 'Vite app']]) // elsewhere, by script, under its project
    expect(statusText(s)).toBe('1/3 here\u20031 elsewhere')

    // A forgotten server's uptime turns orange.
    expect(v.elsewhere[0]!.isForgotten).toBe(true)
    expect(v.elsewhere[0]!.meta.find(p => p.isWarm)?.text).toBe('3d')

    // A port another server holds is flagged on the launchable.
    const busyPort = { ...s, launchables: [...s.launchables, ...launchConfigs({ configurations: [{ name: 'docs', runtimeExecutable: 'npx', runtimeArgs: ['serve'], port: 5173 }] }, SHOP)] }
    expect(sections(busyPort).here.find(r => r.name === 'docs')?.note).toBe('used by main')

    // Starting and stopping show in the row.
    expect(sections(s, ['pid:100']).here[0]!.state).toBe('stopping')
    expect(sections(s, [`launch:${SHOP}#storybook`]).here.find(r => r.name === 'storybook')?.state).toBe('starting')

    // Nothing to run, nothing running: the count still shows.
    expect(statusText({ ...s, launchables: [], servers: [] })).toBe('0/0 here\u20030 elsewhere')

    // A server run straight (`npx next dev`, named after its program) still stands for the script that runs it,
    // and for that one only: `start` stays ready.
    const next = { ...s.servers[0]!, pid: 150, pids: [150], name: 'next', ports: [3005] }
    const withStart = { ...s, launchables: [...s.launchables, ...packageScripts({ scripts: { start: 'next start' } }, SHOP, 'npm')], servers: [next, s.servers[1]!, s.servers[2]!] }
    const w = sections(withStart)
    expect(w.here.filter(r => r.server).map(r => r.name)).toEqual(['dev'])
    expect(w.here.filter(r => !r.server).map(r => r.name)).toEqual(['api', 'storybook', 'start'])

    // Without git, a server run from a subfolder of the project is still the project's.
    const plain = `${HOME}/code/plain`
    const inside = { ...s.servers[2]!, cwd: `${plain}/site`, top: `${plain}/site`, repo: `${plain}/site`, projectName: 'site', branch: '' }
    const noGit = sections({ project: { cwd: plain, top: plain, repo: plain, name: 'plain', branch: '' }, launchables: [], servers: [inside, s.servers[0]!] })
    expect(noGit.here.map(r => r.name)).toEqual(['vite'])
    expect(noGit.elsewhere.map(r => r.server!.projectName)).toEqual(['shop'])
  })

  test('the demo shows every kind of row', () => {
    const v = sections(demoSnapshot())
    expect(v.here.map(r => [r.name, r.state])).toEqual([['dev', 'running'], ['storybook', 'ready'], ['preview', 'ready']])
    expect(v.here[0]!.meta[0]!.text).toBe('this pane')
    expect(v.other.map(r => r.meta.slice(0, 2).map(p => p.text))).toEqual([['iTerm', 'main']])
    const g = groups(v.elsewhere)
    expect(g.map(x => [x.name, x.branch, x.folder, x.rows.map(r => r.name)])).toEqual([
      ['api-billing', 'dev', '~/code', ['uvicorn']],
      ['docs', 'main', '~/code', ['dev', 'storybook']], // one group, two servers
      ['portfolio', 'main', '~/code', ['vite']],
    ])
    expect(g[0]!.rows[0]!.meta[0]!.text).toBe('Claude, another conversation')
    expect(g[2]!.rows[0]!.meta.map(p => p.text).slice(0, 2)).toEqual(['detached', '3d'])
    expect(g[2]!.rows[0]!.isForgotten).toBe(true)
    expect(groupSvg(g[1]!, 600, true)).toContain('~/code')
  })

  test('tells what started a server', () => {
    const CLAUDE_APP = '/Users/me/Library/Application Support/Claude/claude-code/2.1.299/x/claude.app/Contents/MacOS/claude --output-format stream-json'
    const procs = parsePs([
      '    1     0 10-00:00:00  1000  0.0 /sbin/launchd',
      `  700     1 01:00:00  9000  0.0 ${CLAUDE_APP}`,
      '  701   700    10:00  9000  0.0 npm run dev', // the pane: run by Claude itself, no shell between
      "  702   700    10:00  9000  0.0 /bin/zsh -c -l source /tmp/snapshot.sh && eval 'npm run dev'", // Claude's Bash tool
      '  703   702    10:00  9000  0.0 npm run dev',
      `  800     1 01:00:00  9000  0.0 ${CLAUDE_APP}`,
      '  801   800    10:00  9000  0.0 python3 -m http.server 8766',
      '  900     1 01:00:00  9000  0.0 /Applications/iTerm.app/Contents/MacOS/iTerm2',
      '  901   900 01:00:00  9000  0.0 -zsh',
      '  902   901    10:00  9000  0.0 node server.js',
      '  950     1    10:00  9000  0.0 node orphan.js',
      '  999   700    00:00  1000  0.0 /bin/ps -axo pid=,ppid=,etime=,rss=,%cpu=,command=',
    ].join('\n'))
    const self = selfClaude(procs)
    expect(self).toBe(700) // the Claude above the `ps` the mod ran
    const label = (root: number, s?: number) => originText(originOf(root, procs, s))
    expect(label(701, self)).toBe('this pane')
    expect(label(702, self)).toBe('Claude, this conversation')
    expect(label(801, self)).toBe('Claude, another conversation')
    expect(label(801)).toBe('Claude') // which conversation unknown: no guess
    expect(label(902, self)).toBe('iTerm')
    expect(label(950, self)).toBe('detached')
    expect(label(99, undefined)).toBe('') // not in this table
    expect(originText(originOf(99, parsePs(PS)))).toBe('Terminal') // a login shell, no app named
    expect(folderOf('/Users/me/Documents/Code/2026 T4/2026 Claude mods/claude-mod-quiet-cost')).toBe('~/…/2026 Claude mods')
    expect(folderOf('/Users/me/code/blog')).toBe('~/code')
  })

  test('"Launch all" starts the dev servers, not the ones that serve a build', () => {
    const s = snapshotFixture()
    const extra = packageScripts({ scripts: { start: 'next start', preview: 'vite preview', web: 'vite --port 6006' } }, SHOP, 'npm')
    const rows = sections({ ...s, launchables: [...s.launchables, ...extra] }).here
    expect(launchBatch(rows).map(l => l.name)).toEqual(['api', 'storybook']) // web wants storybook's port: left out
  })

  test('figures and drawing', () => {
    expect(duration(30_000)).toBe('30s')
    expect(duration(12 * 60_000)).toBe('12m')
    expect(duration(3 * 3_600_000)).toBe('3h')
    expect(duration(2 * 86_400_000)).toBe('2d')
    expect(memory(348_160)).toBe('340 MB')
    expect(memory(1_887_437)).toBe('1.8 GB')
    expect(fit('feat/very-long-branch-name', 60)).toBe('feat/ve…')
    expect(fit('main', 60)).toBe('main')
    expect(wrap('one two three four', 70)).toEqual(['one two', 'three four'])
    expect(emptySvg(['Nothing to run here yet.'], 400, '<path d="M8 52h64"/>')).toContain('<rect') // the empty state's ground
    expect(emptySvg(['Nothing to run here yet.'], 400, '<path d="M8 52h64"/>')).toContain('<path d="M8 52h64"/>') // and its drawing

    const v = sections(snapshotFixture())
    const row = { ...v.here[0]!, description: 'a <b> & c' }
    const svg = rowSvg(row, 600)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('a &lt;b&gt; &amp; c') // escaped, or the picture fails to load
    expect(svg).not.toContain('#e08a3c') // grey while nothing is wrong
    expect(rowSvg(v.elsewhere[0]!, 600)).toContain('#e08a3c') // the uptime of a forgotten server turns orange

    // Running: a wave drifting, one wavelength in 5 s; ready: the empty dot, still.
    expect(indicatorSvg('running', -1.5)).toContain('dur="5s" begin="-1.50s"')
    expect(indicatorSvg('ready')).not.toContain('animateTransform')
    expect(portSvg(v.here[0]!)).toContain('<rect') // something listens: the port sits on its ground
    expect(portSvg(v.here[2]!)).not.toContain('<rect')
  })

  test('the count stays in the status line', async ($, on) => {
    const { ran, statuses } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: SHOP } as any)
    await settle()
    expect(ran.some(a => a[0] === '/usr/sbin/lsof' && a.includes('-iTCP'))).toBe(true)
    expect(statuses.at(-1)).toBe('1/3 here\u20031 elsewhere')
    expect(await $.command.run({ command: 'quiet-server', args: 'status' } as any)).toMatchObject({ text: expect.stringContaining('hidden') })
    expect(statuses.at(-1)).toBeUndefined()
  })

  test('the footer has a button for the pane, on the desktop', async ($, on) => {
    const { opened } = engine(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: SHOP } as any)
    await settle()
    const footer = await $.ui.mount({ plugin: 'quiet-server', surface: 'desktop', component: 'SessionMode', props: { modes: [] } } as any)
    expect(await footer.find({ type: 'Button' })).toBeDefined()
    expect(await footer.find({ type: 'Text', text: 'focus' })).toBeDefined() // the engine's own labels stay
    await footer.press({ key: 'pane-toggle' })
    await settle()
    expect(opened).toEqual(['servers'])
    await $.command.run({ command: 'quiet-server', args: 'status' } as any)
    expect(await footer.find({ type: 'Button' })).toBeUndefined() // hidden with the count
    await footer.unmount()
    const terminal = await $.ui.mount({ plugin: 'quiet-server', surface: 'terminal', component: 'SessionMode', props: { modes: [] } } as any)
    expect(await terminal.find({ type: 'Button' })).toBeUndefined() // the terminal keeps /quiet-server
    await terminal.unmount()
  })

  test('the terminal pane: this project first, then what runs elsewhere', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: SHOP } as any)
    await settle()
    const pane = await $.ui.mount({ plugin: 'quiet-server', surface: 'terminal', ...PANE } as any)
    expect(await pane.find({ type: 'Text', text: 'This project' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'feat/login · this conversation' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'storybook' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Other branches' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Running elsewhere' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'blog' })).toBeDefined()
    await pane.unmount()
  })

  test('the desktop pane draws SVG rows with their buttons', async ($, on) => {
    const { ran, browsed } = engine(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: SHOP } as any)
    await settle()
    const pane = await $.ui.mount({ plugin: 'quiet-server', surface: 'desktop', ...PANE } as any)
    expect(await pane.find({ type: 'Svg' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Open in browser' })).toBeDefined() // a button's tooltip
    await pane.press({ key: 'pid:100:preview' })
    expect(browsed).toEqual([['Claude_Browser', 'preview_start', { url: 'http://localhost:3000' }]]) // Claude's own browser
    await pane.press({ key: 'pid:100:open' })
    expect(ran.some(a => a[0] === '/usr/bin/open' && a[1] === 'http://localhost:3000')).toBe(true)
    await pane.press({ key: 'pid:100:stop' })
    expect(ran.find(a => a[0] === '/bin/kill')).toEqual(['/bin/kill', '-TERM', '99', '100', '101']) // the launcher and everything it runs
    expect(await pane.find({ type: 'Text', text: 'Copy URL' })).toBeDefined() // the port copies the URL
    await pane.unmount()
  })

  test('the pane shows or hides the count, and asks Claude for servers', async ($, on) => {
    const { filled, statuses } = engine(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: SHOP } as any)
    await settle()
    const pane = await $.ui.mount({ plugin: 'quiet-server', surface: 'desktop', ...PANE } as any)
    expect(await pane.find({ type: 'Text', text: 'Hide the count and button under the prompt' })).toBeDefined()
    await pane.press({ key: 'pane-status' })
    expect(statuses.at(-1)).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: 'Show the count and button under the prompt' })).toBeDefined()
    await pane.press({ key: 'pane-status' })
    expect(statuses.at(-1)).toBe('1/3 here\u20031 elsewhere')
    await pane.press({ key: 'ask-add' })
    await pane.press({ key: 'ask-find' })
    expect(filled.map(t => t.split(' ').slice(0, 3).join(' '))).toEqual(['Add a dev', 'Look through this']) // the prompt box, for the person to send
    await pane.unmount()
  })

  test('"Stop all" asks once more, then stops every server of the project', async ($, on) => {
    const { ran } = engine(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: SHOP } as any)
    await settle()
    const pane = await $.ui.mount({ plugin: 'quiet-server', surface: 'desktop', ...PANE } as any)
    await pane.press({ key: 'stop-project' })
    expect(ran.some(a => a[0] === '/bin/kill')).toBe(false)
    expect(await pane.find({ type: 'Text', text: 'Press again to stop them' })).toBeDefined()
    await pane.press({ key: 'stop-project' })
    expect(ran.filter(a => a[0] === '/bin/kill' && a[1] === '-TERM').map(a => a.slice(2))).toEqual([['99', '100', '101'], ['199', '200']]) // this branch and the other one, not blog
    await pane.unmount()
  })
})
