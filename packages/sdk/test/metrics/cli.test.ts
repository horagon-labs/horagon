import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_RPC,
  type FanReport,
  formatReport,
  main,
  type WalletsFile,
} from '../../../../scripts/count-fans.mjs'
import {
  type FakeChain,
  fakeClock,
  fakeRpc,
  fakeSignature,
  gameMarketKey,
  pmAmmMarketKey,
  type RpcRequest,
  type Season,
  seasonChain,
  walletKey,
} from './fake-chain'

const SCRIPT = fileURLToPath(new URL('../../../../scripts/count-fans.mjs', import.meta.url))
const DEFAULT_WALLETS = fileURLToPath(
  new URL('../../../../docs/metrics-wallets.json', import.meta.url),
)
const RPC_URL = 'http://127.0.0.1:8899'
const USAGE = 'usage: node scripts/count-fans.mjs'
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../../tests/fixtures/metrics/${name}`, import.meta.url), 'utf8'),
  )

interface SeasonFixture {
  season: Season
  expected: Omit<FanReport, 'excluded'> & {
    excluded: { market: string; reason: string; nonTeamSwaps: number }[]
  }
}
const seasonBasic = fixture('season-basic.json') as SeasonFixture
const seasonReport = (): FanReport => ({
  ...seasonBasic.expected,
  excluded: seasonBasic.expected.excluded.map(({ market, ...rest }) => ({
    gameMarket: gameMarketKey(market),
    ...rest,
  })),
})
const bigMarket = fixture('big-market.json') as { season: Season; expected: FanReport }
const EMPTY: WalletsFile = { version: 1, teamWallets: [], excludedMarkets: [] }

interface Run {
  code: number
  stdout: string
  stderr: string
  /** Every request that reached the fake node. */
  requests: RpcRequest[]
  /** Every path main asked to read. */
  reads: string[]
}

/** Runs main on a fake node and a fake clock, with `files` as the only readable files. */
async function run(
  argv: string[],
  setup: {
    chain?: Pick<FakeChain, 'accounts' | 'transactions'>
    files?: Record<string, string>
    wrap?: (serve: typeof fetch) => typeof fetch
  } = {},
): Promise<Run> {
  const clock = fakeClock()
  const node = fakeRpc(setup.chain ?? { accounts: [], transactions: [] }, clock)
  const out = { stdout: '', stderr: '' }
  const reads: string[] = []
  const code = await main(argv, {
    fetch: setup.wrap?.(node.fetch) ?? node.fetch,
    stdout: (s) => {
      out.stdout += s
    },
    stderr: (s) => {
      out.stderr += s
    },
    now: clock.now,
    sleep: clock.sleep,
    readFile: (path) => {
      reads.push(path)
      const text = setup.files?.[path]
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
          code: 'ENOENT',
        })
      }
      return text
    },
  })
  return { code, ...out, requests: node.requests, reads }
}

describe('main: the count', () => {
  const chain = seasonChain(seasonBasic.season)
  const files = { 'wallets.json': JSON.stringify(chain.wallets) }
  const argv = ['--rpc', RPC_URL, '--wallets', 'wallets.json']

  it('prints the report of the season fixture', async () => {
    const r = await run(argv, { chain, files })
    expect(r.code).toBe(0)
    // One request every 250 ms, and the fake node answers at once.
    const elapsedMs = (r.requests.length - 1) * 250
    expect(r.stdout).toBe(`${formatReport(seasonReport(), { rpc: RPC_URL, elapsedMs })}\n`)
    expect(r.stdout).toContain('\n3-Night Fans (human wallets): 1\n')
    expect(r.stdout).toContain('\nmarkets: 8 counted, 1 excluded, 2 ignored\n')
    expect(r.reads).toEqual(['wallets.json'])
    expect(r.requests.every((q) => q.url === RPC_URL)).toBe(true)
  })

  it('reads the transactions of counted and excluded markets only', async () => {
    const r = await run(argv, { chain, files })
    const read = ['rehearsal', 'pre', 'n1-a', 'n1-a-clutch', 'n1-b', 'n2', 'n3', 'n4', 'post']
    expect(r.requests[0]?.method).toBe('getProgramAccounts')
    expect(
      r.requests.filter((q) => q.method === 'getSignaturesForAddress').map((q) => q.params[0]),
    ).toEqual(read.map(pmAmmMarketKey))
    // ivy's transaction on n1-a and n1-b is listed twice and fetched once.
    const fetched = r.requests
      .filter((q) => q.method === 'getTransaction')
      .map((q) => String(q.params[0]))
    expect(new Set(fetched).size).toBe(fetched.length)
    expect(fetched.filter((s) => s === fakeSignature('ivy-two-markets'))).toHaveLength(1)
  })

  it('prints the report as JSON with --json, plus rpc and elapsedMs', async () => {
    const r = await run(['--json', ...argv], { chain, files })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      ...seasonReport(),
      rpc: RPC_URL,
      elapsedMs: (r.requests.length - 1) * 250,
    })
    expect(r.stdout.endsWith('}\n')).toBe(true)
  })

  it('writes progress to stderr and nothing but the report to stdout', async () => {
    const r = await run(argv, { chain, files })
    const transactions = r.requests.filter((q) => q.method === 'getTransaction').length
    expect(r.stderr).toContain(
      'count-fans: 11 GameMarket accounts on http://127.0.0.1:8899; reading the transactions of ' +
        '9 counted or excluded markets\n',
    )
    expect(r.stderr).toContain(`count-fans: transactions 0/${transactions}\n`)
    expect(r.stderr).toContain(`count-fans: transactions ${transactions}/${transactions}\n`)
    expect(r.stderr).toContain(`count-fans: RPC requests sent: ${r.requests.length}\n`)
    expect(
      r.stderr.split('\n').every((line) => line === '' || line.startsWith('count-fans: ')),
    ).toBe(true)
    expect(r.stdout.startsWith('Horagon 3-Night Fans (scripts/count-fans.mjs)\n')).toBe(true)
    expect(r.stdout).not.toContain('count-fans:')
  })

  it('counts the 1,203-signature market end to end at 4 requests a second', async () => {
    const big = seasonChain(bigMarket.season)
    const r = await run(['--json', '--rpc', RPC_URL, '--wallets', 'w.json'], {
      chain: big,
      files: { 'w.json': JSON.stringify(big.wallets) },
    })
    expect(r.code).toBe(0)
    // 1 getProgramAccounts, 3 signature pages, 1,202 transactions.
    expect(r.requests).toHaveLength(1206)
    expect(JSON.parse(r.stdout)).toEqual({
      ...bigMarket.expected,
      rpc: RPC_URL,
      elapsedMs: 301_250,
    })
  })

  it('prints zeros and exits 0 on a chain without GameMarkets, from the default RPC', async () => {
    const r = await run(['--wallets', 'w.json'], { files: { 'w.json': JSON.stringify(EMPTY) } })
    expect(r.code).toBe(0)
    expect(r.requests.map((q) => [q.url, q.method])).toEqual([[DEFAULT_RPC, 'getProgramAccounts']])
    expect(r.stdout).toContain('\nrpc: https://api.devnet.solana.com\n')
    expect(r.stdout).toContain('\nmarkets: 0 counted, 0 excluded, 0 ignored\n')
    expect(r.stdout).toContain('\nswaps: 0 on counted markets, 0 night touches\n')
    expect(r.stdout).toContain('\n3-Night Fans (human wallets): 0\n')
    expect(r.stdout).toMatch(/^human +0 +0 +0 +0 +0$/m)
    expect(r.stdout).toContain(
      '\nper ET night: wallets with a night touch, then night touches\n' +
        'night (ET)  human  bot  team  human touches  bot touches  team touches\n',
    )
    expect(r.stdout).toMatch(/^2026-11-23 +0 +0 +0 +0 +0 +0$/m)
    expect(r.stdout).toMatch(/^2026-12-04 +0 +0 +0 +0 +0 +0$/m)
    expect(r.stdout).toContain('\nexcluded markets: 0 listed in the wallets file, 0 on chain\n')
    expect(r.stdout.endsWith('\nelapsed: 0.0 s\n')).toBe(true)
    expect(r.stderr).toContain('count-fans: transactions 0/0\n')
  })

  it('shows only the origin of the RPC URL', async () => {
    const url = 'https://rpc.example.test/v2/KEY-IN-PATH?api-key=KEY-IN-QUERY'
    const r = await run(['--rpc', url, '--wallets', 'w.json'], {
      files: { 'w.json': JSON.stringify(EMPTY) },
    })
    expect(r.code).toBe(0)
    expect(r.requests.map((q) => q.url)).toEqual([url])
    expect(r.stdout).toContain('\nrpc: https://rpc.example.test\n')
    expect(`${r.stdout}${r.stderr}`).not.toContain('KEY-IN')
  })
})

describe('main: RPC failures', () => {
  const chain = seasonChain(seasonBasic.season)
  const files = { 'wallets.json': JSON.stringify(chain.wallets) }
  const argv = ['--wallets', 'wallets.json']

  it('exits 3 and prints no number when the node keeps answering 429', async () => {
    const r = await run(argv, {
      chain,
      files,
      wrap: (serve) => async (input: RequestInfo | URL, init?: RequestInit) => {
        await serve(input, init)
        return new Response('', { status: 429 })
      },
    })
    expect(r.code).toBe(3)
    expect(r.requests).toHaveLength(9)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('count-fans: getProgramAccounts: 429, retry 1 in 0.5 s\n')
    expect(r.stderr).toContain('count-fans: getProgramAccounts: 429, retry 8 in 8.0 s\n')
    expect(
      r.stderr.endsWith(
        'count-fans: getProgramAccounts failed after 8 retries (429)\n' +
          'count-fans: stopped: no number was printed\n',
      ),
    ).toBe(true)
  })

  it('exits 3 and prints no number when a transaction stays unavailable', async () => {
    const missing = fakeSignature('ivy-two-markets')
    const r = await run(argv, {
      chain,
      files,
      wrap: (serve) => async (input: RequestInfo | URL, init?: RequestInit) => {
        const answer = await serve(input, init)
        const { id, method, params } = JSON.parse(String(init?.body))
        if (method !== 'getTransaction' || params[0] !== missing) return answer
        return new Response(JSON.stringify({ jsonrpc: '2.0', result: null, id }))
      },
    })
    expect(r.code).toBe(3)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('count-fans: getTransaction: null, retry 3 in 2.0 s\n')
    expect(
      r.stderr.endsWith(
        `count-fans: transaction ${missing} not available\n` +
          'count-fans: stopped: no number was printed\n',
      ),
    ).toBe(true)
  })

  it('exits 3 and prints no number when a signature page has an entry without err', async () => {
    const r = await run(argv, {
      chain,
      files,
      wrap: (serve) => async (input: RequestInfo | URL, init?: RequestInit) => {
        const answer = await serve(input, init)
        if (JSON.parse(String(init?.body)).method !== 'getSignaturesForAddress') return answer
        const body = await answer.json()
        const [first, ...rest] = body.result as Record<string, unknown>[]
        const { err: _err, ...entry } = first ?? {}
        return new Response(JSON.stringify({ ...body, result: [entry, ...rest] }))
      },
    })
    expect(r.code).toBe(3)
    expect(r.stdout).toBe('')
    expect(
      r.stderr.endsWith(
        `count-fans: getSignaturesForAddress returned a malformed entry for ${pmAmmMarketKey('rehearsal')}\n` +
          'count-fans: stopped: no number was printed\n',
      ),
    ).toBe(true)
  })

  type TxChange = (tx: Record<string, unknown>) => Record<string, unknown>
  // Answers of a node that has the transaction, but not in full yet.
  const incomplete: [string, TxChange][] = [
    ['meta is null', (tx) => ({ ...tx, meta: null })],
    [
      'meta is missing',
      (tx) => Object.fromEntries(Object.entries(tx).filter(([k]) => k !== 'meta')),
    ],
    ['blockTime is null', (tx) => ({ ...tx, blockTime: null })],
  ]
  const ivy = fakeSignature('ivy-two-markets')
  /** Answers the first `times` getTransaction calls for ivy with the transaction changed. */
  const changeIvy =
    (change: TxChange, times = Number.POSITIVE_INFINITY) =>
    (serve: typeof fetch): typeof fetch =>
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await serve(input, init)
      const { method, params } = JSON.parse(String(init?.body))
      if (method !== 'getTransaction' || params[0] !== ivy || times-- <= 0) return answer
      const body = await answer.json()
      return new Response(JSON.stringify({ ...body, result: change(body.result) }))
    }

  it.each(incomplete)(
    'exits 3 and prints no number when the %s in every answer',
    async (_name, change) => {
      const r = await run(argv, { chain, files, wrap: changeIvy(change) })
      expect(r.code).toBe(3)
      expect(r.stdout).toBe('')
      const asked = r.requests.filter((q) => q.method === 'getTransaction' && q.params[0] === ivy)
      expect(asked).toHaveLength(4)
      expect(r.stderr).toContain('count-fans: getTransaction: null, retry 3 in 2.0 s\n')
      expect(
        r.stderr.endsWith(
          `count-fans: transaction ${ivy} not available\n` +
            'count-fans: stopped: no number was printed\n',
        ),
      ).toBe(true)
    },
  )

  it.each(incomplete)(
    'counts right when a transaction arrives in full after one whose %s',
    async (_name, change) => {
      const r = await run(['--json', ...argv], { chain, files, wrap: changeIvy(change, 1) })
      expect(r.code).toBe(0)
      expect(r.stderr).toContain('count-fans: getTransaction: null, retry 1 in 0.5 s\n')
      expect(JSON.parse(r.stdout)).toEqual({
        ...seasonReport(),
        rpc: DEFAULT_RPC,
        elapsedMs: (r.requests.length - 1) * 250 + 250,
      })
    },
  )
})

describe('main: usage and config errors', () => {
  it.each([
    [['--bogus'], "'--bogus'"],
    [['--rpc'], "'--rpc"],
    [['extra'], "'extra'"],
    [['--rpc', 'ftp://example.test'], '--rpc needs an http or https URL'],
    [['--rpc', 'not a url'], '--rpc needs an http or https URL'],
    [['--rpc', 'https://key@example.test'], '--rpc must not contain a user name or password'],
    [['--rpc', 'https://:pa55@example.test'], '--rpc must not contain a user name or password'],
    [['--previous', 'old.json'], '--previous goes with --check-wallets'],
    [['--check-wallets', '--json'], '--check-wallets reads only the wallets files'],
    [['--check-wallets', '--rpc', RPC_URL], '--check-wallets reads only the wallets files'],
  ])('exits 2 on %j', async (argv, message) => {
    const r = await run(argv, { files: { [DEFAULT_WALLETS]: JSON.stringify(EMPTY) } })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(message)
    expect(r.stderr).toContain(`\n${USAGE} [--rpc <url>] [--wallets <path>] [--json]\n`)
    expect(r.stdout).toBe('')
    expect(r.reads).toEqual([])
    expect(r.requests).toEqual([])
  })

  it('reads docs/metrics-wallets.json by default and exits 2 when it is missing', async () => {
    const r = await run([])
    expect(r.code).toBe(2)
    expect(r.reads).toEqual([DEFAULT_WALLETS])
    expect(r.stderr).toBe(`count-fans: cannot read ${DEFAULT_WALLETS} (ENOENT)\n`)
    expect(r.stdout).toBe('')
    expect(r.requests).toEqual([])
  })

  it.each([
    ['missing', undefined, 'count-fans: cannot read w.json (ENOENT)\n'],
    ['not JSON', '{"version": 1,', /^count-fans: w\.json is not valid JSON \(.+\)\n$/],
    [
      'not a valid wallets file',
      JSON.stringify({ ...EMPTY, teamWallets: [{ pubkey: walletKey('x'), role: 'founder' }] }),
      'count-fans: w.json is not a valid wallets file:\n' +
        'count-fans: teamWallets[0].role: unknown role\n' +
        'count-fans: teamWallets[0].addedAt: not a UTC date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)\n',
    ],
  ])('exits 2 before any RPC call when the wallets file is %s', async (_name, text, stderr) => {
    const files: Record<string, string> = text === undefined ? {} : { 'w.json': text }
    const r = await run(['--wallets', 'w.json'], { files })
    expect(r.code).toBe(2)
    if (typeof stderr === 'string') expect(r.stderr).toBe(stderr)
    else expect(r.stderr).toMatch(stderr)
    expect(r.stdout).toBe('')
    expect(r.requests).toEqual([])
  })
})

describe('main: --check-wallets', () => {
  const valid: WalletsFile = {
    version: 1,
    teamWallets: [
      { pubkey: walletKey('deployer'), role: 'deployer', addedAt: '2026-11-23' },
      { pubkey: walletKey('burner-1'), role: 'team-burner', addedAt: '2026-11-23' },
    ],
    excludedMarkets: [],
  }
  const burner2 = { pubkey: walletKey('burner-2'), role: 'team-burner', addedAt: '2026-11-25' }
  const files = {
    'ok.json': JSON.stringify(valid),
    'appended.json': JSON.stringify({ ...valid, teamWallets: [...valid.teamWallets, burner2] }),
    'removed.json': JSON.stringify({ ...valid, teamWallets: valid.teamWallets.slice(0, 1) }),
    'inserted.json': JSON.stringify({ ...valid, teamWallets: [burner2, ...valid.teamWallets] }),
    'invalid.json': JSON.stringify({ ...valid, version: 2, teamWallets: [] }),
    'broken.json': '{"version": 1,',
  }

  it.each([
    ['a valid file', 0, ['--wallets', 'ok.json'], 'wallets file ok\n'],
    ['an invalid file', 1, ['--wallets', 'invalid.json'], 'version: must be 1\n'],
    ['an append', 0, ['--wallets', 'appended.json', '--previous', 'ok.json'], 'wallets file ok\n'],
    [
      'a removal',
      1,
      ['--wallets', 'removed.json', '--previous', 'ok.json'],
      'teamWallets[1]: removed\n',
    ],
    [
      'an insertion before the others',
      1,
      ['--wallets', 'inserted.json', '--previous', 'ok.json'],
      'teamWallets[0]: changed\nteamWallets[1]: changed\n',
    ],
    [
      'an invalid file against a previous one',
      1,
      ['--wallets', 'invalid.json', '--previous', 'ok.json'],
      'version: must be 1\n',
    ],
  ])('%s: exit %i', async (_name, code, argv, stdout) => {
    const r = await run(['--check-wallets', ...argv], { files })
    expect([r.code, r.stdout, r.stderr]).toEqual([code, stdout, ''])
    expect(r.requests).toEqual([])
  })

  it('fails the check on a file that is not JSON', async () => {
    const r = await run(['--check-wallets', '--wallets', 'broken.json'], { files })
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/^broken\.json is not valid JSON \(.+\)\n$/)
  })

  it.each([
    [
      'the wallets file is missing',
      ['--wallets', 'gone.json'],
      'count-fans: cannot read gone.json (ENOENT)\n',
    ],
    [
      'the previous file is missing',
      ['--wallets', 'ok.json', '--previous', 'gone.json'],
      'count-fans: cannot read gone.json (ENOENT)\n',
    ],
    [
      'the previous file is not valid',
      ['--wallets', 'ok.json', '--previous', 'invalid.json'],
      'count-fans: invalid.json is not a valid wallets file:\ncount-fans: version: must be 1\n',
    ],
  ])('exits 2 when %s', async (_name, argv, stderr) => {
    const r = await run(['--check-wallets', ...argv], { files })
    expect([r.code, r.stdout, r.stderr]).toEqual([2, '', stderr])
  })
})

describe('the main guard', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'count-fans-'))
    writeFileSync(join(dir, 'wallets.json'), JSON.stringify(EMPTY))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const node = (args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8' })

  it('runs main when the script is the program', () => {
    const r = node([SCRIPT, '--check-wallets', '--wallets', join(dir, 'wallets.json')])
    expect([r.status, r.stdout, r.stderr]).toEqual([0, 'wallets file ok\n', ''])
  })

  it('exits with the code that main returns', () => {
    const r = node([SCRIPT, '--bogus'])
    expect(r.status).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain(USAGE)
  })

  it('runs nothing when another program imports the module', () => {
    // A program file, so process.argv[1] is set and is not the script.
    const importer = join(dir, 'importer.mjs')
    writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})\n`)
    const r = node([importer])
    expect([r.status, r.stdout, r.stderr]).toEqual([0, '', ''])
  })

  it('runs main when the script is reached through a linked directory', () => {
    // A junction on Windows, a directory symlink elsewhere. Unlinked in finally, so that rmSync
    // never walks through it into the repo.
    const link = join(dir, 'linked-scripts')
    symlinkSync(dirname(SCRIPT), link, 'junction')
    try {
      const r = node([
        join(link, 'count-fans.mjs'),
        '--check-wallets',
        '--wallets',
        join(dir, 'wallets.json'),
      ])
      expect([r.status, r.stdout, r.stderr]).toEqual([0, 'wallets file ok\n', ''])
    } finally {
      unlinkSync(link)
    }
  })
})

describe('the declarations', () => {
  it('declare exactly the values that the script exports', async () => {
    // The tests and wave 1 type the script through count-fans.d.mts. An export without a
    // declaration cannot be typechecked, and a declaration without an export typechecks a call
    // that fails at run time.
    const declarations = readFileSync(
      new URL('../../../../scripts/count-fans.d.mts', import.meta.url),
      'utf8',
    )
    const declared = [
      ...declarations.matchAll(/^export (function|const|class|interface|type) (\w+)/gm),
    ]
      .filter(([, kind]) => kind !== 'interface' && kind !== 'type')
      .map(([, , name]) => name)
    const script = await import('../../../../scripts/count-fans.mjs')
    expect(Object.keys(script).sort()).toEqual([...new Set(declared)].sort())
  })
})
