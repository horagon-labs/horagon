import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BOT_MEMO,
  BOT_RATE,
  base58Decode,
  base58Encode,
  checkAppendOnly,
  countFans,
  DEFAULT_RPC,
  decodeGameMarket,
  etNight,
  extractSwaps,
  type FanReport,
  formatReport,
  GAME_MARKET_DISCRIMINATOR,
  HORAGON_PROGRAM_ID,
  hasBotMemo,
  inWindow,
  isRateBot,
  MEMO_PROGRAM_ID,
  PM_AMM_PROGRAM_ID,
  type RawInstruction,
  type RawTransaction,
  SWAP_DISCRIMINATOR,
  type TeamRole,
  validateWalletsFile,
  type WalletsFile,
  WINDOW,
} from '../../../../scripts/count-fans.mjs'
import {
  DISCRIMINATORS,
  fakeKey,
  fakeSignature,
  gameMarketData,
  gameMarketKey,
  PROGRAMS,
  pmAmmInstruction,
  pmAmmMarketKey,
  rawTransaction,
  type Season,
  type SeasonMarket,
  type SeasonSwap,
  SPONSOR,
  seasonChain,
  swapData,
  type TradeInput,
  toBase58,
  tradeTransaction,
  utf8,
  walletKey,
} from './fake-chain'

const WINDOW_NIGHTS = [
  '2026-11-27',
  '2026-11-28',
  '2026-11-29',
  '2026-11-30',
  '2026-12-01',
  '2026-12-02',
  '2026-12-03',
  '2026-12-04',
  '2026-12-05',
  '2026-12-06',
  '2026-12-07',
  '2026-12-08',
  '2026-12-09',
  '2026-12-10',
]
const unix = (iso: string) => Date.parse(iso) / 1000
const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

/** The pipeline of the script on fake chain data: decode the accounts, extract, count. */
function count(season: Season): FanReport {
  const chain = seasonChain(season)
  const markets = chain.accounts.map(({ address, data }) => ({
    address,
    ...decodeGameMarket(data),
  }))
  const pmAmmMarkets = new Set(markets.map((m) => m.market))
  const swaps = chain.transactions.flatMap((tx) => extractSwaps(tx, pmAmmMarkets))
  return countFans({ markets, swaps, wallets: chain.wallets })
}

const nightRow = (report: FanReport, night: string) => report.nights.find((n) => n.night === night)

describe('constants', () => {
  it('match the program ids and the Anchor discriminators', () => {
    const anchor = (preimage: string) => [
      ...createHash('sha256').update(preimage).digest().subarray(0, 8),
    ]
    expect(HORAGON_PROGRAM_ID).toBe(PROGRAMS.horagon)
    expect(PM_AMM_PROGRAM_ID).toBe(PROGRAMS.pmAmm)
    expect(MEMO_PROGRAM_ID).toBe(PROGRAMS.memo)
    expect([...GAME_MARKET_DISCRIMINATOR]).toEqual(anchor('account:GameMarket'))
    expect([...GAME_MARKET_DISCRIMINATOR]).toEqual([...DISCRIMINATORS.gameMarket])
    expect(toBase58(GAME_MARKET_DISCRIMINATOR)).toBe('6t71NUb8zXs')
    expect([...SWAP_DISCRIMINATOR]).toEqual(anchor('global:swap'))
    expect([...SWAP_DISCRIMINATOR]).toEqual([...DISCRIMINATORS.swap])
  })

  it('pin the window, the bot rules and the default RPC', () => {
    expect(WINDOW).toEqual({ first: '2026-11-27', last: '2026-12-10' })
    expect(BOT_RATE).toEqual({ swaps: 20, seconds: 300 })
    expect(BOT_MEMO).toBe('horagon:bot')
    expect(DEFAULT_RPC).toBe('https://api.devnet.solana.com')
  })
})

describe('base58', () => {
  // 64 samples of 1 to 32 bytes, some with leading zero bytes.
  const samples = Array.from({ length: 64 }, (_, i) => {
    const bytes = Uint8Array.from(
      createHash('sha256')
        .update(`sample:${i}`)
        .digest()
        .subarray(0, 1 + (i % 32)),
    )
    return bytes.fill(0, 0, i % 4)
  })

  it('agrees with an independent BigInt encoder, leading zeros included', () => {
    for (const bytes of samples) {
      const text = toBase58(bytes)
      expect(base58Encode(bytes)).toBe(text)
      expect([...base58Decode(text)]).toEqual([...bytes])
    }
  })

  it('encodes known values', () => {
    expect(base58Encode(new Uint8Array(32))).toBe(PROGRAMS.system)
    expect(base58Encode(new Uint8Array(0))).toBe('')
    expect([...base58Decode('')]).toEqual([])
    expect(base58Decode(PROGRAMS.pmAmm)).toHaveLength(32)
  })

  it.each(['0', 'O', 'I', 'l', '+', ' '])('rejects the character %j', (c) => {
    expect(() => base58Decode(`abc${c}def`)).toThrow(/invalid base58 character/)
  })
})

describe('decodeGameMarket', () => {
  const tipoff = unix('2026-11-23T19:30:00-05:00')
  const fields = {
    marketLabel: 'pm-amm/m1',
    marketId: 7n,
    kind: 0,
    league: 'NBA',
    gameId: '401810123',
    home: 'HOM',
    away: 'AWY',
    scheduledTipoff: tipoff,
  }

  it('reads a full 326-byte account', () => {
    const data = gameMarketData(fields)
    expect(data).toHaveLength(326)
    expect(decodeGameMarket(data)).toEqual({
      market: fakeKey('pm-amm/m1'),
      kind: 0,
      league: 'NBA',
      gameId: '401810123',
      scheduledTipoff: tipoff,
    })
  })

  it.each(['', 'x', '0123456789abcdef'])('finds the tipoff after the game id %j', (gameId) => {
    const decoded = decodeGameMarket(gameMarketData({ ...fields, gameId }))
    expect(decoded.gameId).toBe(gameId)
    expect(decoded.scheduledTipoff).toBe(tipoff)
  })

  it.each([1, 2, 255])('accepts kind %i', (kind) => {
    expect(decodeGameMarket(gameMarketData({ ...fields, kind })).kind).toBe(kind)
  })

  it('trims the zero padding of the league and keeps a full 8-byte league', () => {
    expect(decodeGameMarket(gameMarketData({ ...fields, league: 'NBA' })).league).toBe('NBA')
    const practice = decodeGameMarket(gameMarketData({ ...fields, league: 'PRACTICE' }))
    expect(practice.league).toBe('PRACTICE')
  })

  it('reads data that sits at an offset inside a larger buffer', () => {
    const data = gameMarketData(fields)
    const larger = new Uint8Array(400)
    larger.set(data, 17)
    expect(decodeGameMarket(larger.subarray(17, 17 + 326))).toEqual(decodeGameMarket(data))
  })

  it('rejects a wrong discriminator', () => {
    const config = gameMarketData({ ...fields, discriminator: DISCRIMINATORS.config })
    expect(() => decodeGameMarket(config)).toThrow(/wrong discriminator/)
  })

  it('rejects short data', () => {
    const data = gameMarketData(fields)
    expect(() => decodeGameMarket(data.subarray(0, 60))).toThrow(/too short/)
    // 61 + 9 (game id) + 8 (home, away) + 7: one byte short of the tipoff.
    expect(() => decodeGameMarket(data.subarray(0, 85))).toThrow(/too short/)
    expect(decodeGameMarket(data.subarray(0, 86)).scheduledTipoff).toBe(tipoff)
  })
})

describe('etNight', () => {
  it.each([
    ['2026-11-27T04:59:59Z', '2026-11-26'], // 23:59:59 EST, the night before the window
    ['2026-11-27T05:00:00Z', '2026-11-27'], // midnight EST, the first night of the window
    ['2026-12-11T04:59:59Z', '2026-12-10'], // 23:59:59 EST, the last night of the window
    ['2026-12-11T05:00:00Z', '2026-12-11'], // midnight EST, the night after the window
    ['2026-11-01T03:59:59Z', '2026-10-31'], // 23:59:59 EDT
    ['2026-11-01T04:00:00Z', '2026-11-01'], // midnight EDT, on the day daylight time ends
    ['2026-11-01T05:30:00Z', '2026-11-01'], // 01:30 EDT, before the clocks go back
    ['2026-11-01T06:30:00Z', '2026-11-01'], // 01:30 EST, after
    ['2026-11-02T04:59:59Z', '2026-11-01'], // 23:59:59 EST: 2026-11-01 lasts 25 hours
    ['2026-11-02T05:00:00Z', '2026-11-02'],
  ])('%s falls on the ET night %s', (time, night) => {
    expect(etNight(unix(time))).toBe(night)
  })
})

describe('inWindow', () => {
  it.each([
    ['2026-11-25', false],
    ['2026-11-26', false],
    ['2026-11-27', true],
    ['2026-11-30', true],
    ['2026-12-04', true],
    ['2026-12-05', true],
    ['2026-12-10', true],
    ['2026-12-11', false],
    ['2026-11-27T00', false],
    ['', false],
  ])('%j -> %s', (night, expected) => {
    expect(inWindow(night)).toBe(expected)
  })
})

describe('hasBotMemo and extractSwaps', () => {
  const M1 = pmAmmMarketKey('m1')
  const M2 = pmAmmMarketKey('m2')
  const FAN = walletKey('fan')
  const SIG = fakeSignature('trade')
  const T0 = unix('2026-11-24T01:00:00Z')
  const markets = new Set([M1, M2])
  const trade = (over: Partial<TradeInput> = {}) =>
    tradeTransaction({ signature: SIG, blockTime: T0, wallet: FAN, markets: [M1], ...over })

  it.each([
    ['exact', true],
    ['with-account', false],
    ['wrong-text', false],
    ['legacy-program', false],
    ['inner', false],
  ] as const)('a %s memo -> bot memo %s', (memo, expected) => {
    expect(hasBotMemo(trade({ memo }))).toBe(expected)
    expect(extractSwaps(trade({ memo }), markets).map((s) => s.botMemo)).toEqual([expected])
  })

  it('finds no bot memo in a plain trade', () => {
    expect(hasBotMemo(trade())).toBe(false)
  })

  it('returns an unsponsored swap signed by the fee payer', () => {
    expect(extractSwaps(trade(), markets)).toEqual([
      { signature: SIG, wallet: FAN, market: M1, blockTime: T0, botMemo: false },
    ])
  })

  it('takes the wallet from the swap, not from the sponsor that pays the fee', () => {
    const tx = trade({ sponsored: true })
    expect(tx.transaction.message.accountKeys[0]).toBe(SPONSOR)
    expect(tx.transaction.message.header.numRequiredSignatures).toBe(2)
    expect(extractSwaps(tx, markets).map((s) => s.wallet)).toEqual([FAN])
    // The transaction id is the first signature, the sponsor's.
    expect(extractSwaps(tx, markets).map((s) => s.signature)).toEqual([SIG])
  })

  it('returns each swap of a transaction with two swaps', () => {
    const swaps = extractSwaps(trade({ markets: [M1, M2] }), markets)
    expect(swaps.map((s) => [s.signature, s.market])).toEqual([
      [SIG, M1],
      [SIG, M2],
    ])
  })

  it('ignores a swap on a market outside the set', () => {
    expect(extractSwaps(trade({ markets: [pmAmmMarketKey('other')] }), markets)).toEqual([])
  })

  it('reads the market from accounts[1] only', () => {
    const ix = pmAmmInstruction(FAN, pmAmmMarketKey('other'))
    ix.accounts[2] = M1
    const tx = rawTransaction({ signature: SIG, blockTime: T0, signers: [FAN], instructions: [ix] })
    expect(tx.transaction.message.accountKeys).toContain(M1)
    expect(extractSwaps(tx, markets)).toEqual([])
  })

  it.each([
    ['redeem_pair', DISCRIMINATORS.redeemPair],
    ['claim_winnings', DISCRIMINATORS.claimWinnings],
  ])('ignores the pm-AMM %s instruction', (_name, discriminator) => {
    const data = Uint8Array.from([...discriminator, 64, 66, 15, 0, 0, 0, 0, 0])
    const tx = rawTransaction({
      signature: SIG,
      blockTime: T0,
      signers: [FAN],
      instructions: [pmAmmInstruction(FAN, M1, data)],
    })
    expect(extractSwaps(tx, markets)).toEqual([])
  })

  it('ignores swap data sent to another program', () => {
    const tx = rawTransaction({
      signature: SIG,
      blockTime: T0,
      signers: [FAN],
      instructions: [{ ...pmAmmInstruction(FAN, M1), program: PROGRAMS.horagon }],
    })
    expect(extractSwaps(tx, markets)).toEqual([])
  })

  it('ignores a swap reached through a CPI', () => {
    const tx = rawTransaction({
      signature: SIG,
      blockTime: T0,
      signers: [FAN],
      instructions: [{ program: PROGRAMS.horagon, accounts: [FAN, M1], data: utf8('crank') }],
      inner: [{ index: 0, instructions: [pmAmmInstruction(FAN, M1)] }],
    })
    expect(tx.meta?.innerInstructions?.[0]?.instructions).toHaveLength(1)
    expect(extractSwaps(tx, markets)).toEqual([])
  })

  it('ignores a swap whose accounts[0] does not sign the transaction', () => {
    const tx = rawTransaction({
      signature: SIG,
      blockTime: T0,
      signers: [FAN],
      instructions: [pmAmmInstruction(walletKey('someone-else'), M1)],
    })
    expect(extractSwaps(tx, markets)).toEqual([])
  })

  it('ignores a failed transaction, one without a block time, and one without meta', () => {
    const failed = rawTransaction({
      signature: SIG,
      blockTime: T0,
      signers: [FAN],
      instructions: [pmAmmInstruction(FAN, M1)],
      err: { InstructionError: [0, { Custom: 6004 }] },
    })
    expect(extractSwaps(failed, markets)).toEqual([])
    expect(extractSwaps({ ...trade(), blockTime: null }, markets)).toEqual([])
    expect(extractSwaps({ ...trade(), meta: null }, markets)).toEqual([])
  })

  it.each([
    ['writable', { writable: [fakeKey('x'), M1], readonly: [fakeKey('y')] }],
    ['readonly', { writable: [fakeKey('x')], readonly: [fakeKey('y'), M1] }],
  ])('resolves a market loaded from a lookup table (%s)', (_list, loaded) => {
    const tx = rawTransaction({
      signature: SIG,
      blockTime: T0,
      signers: [FAN],
      instructions: [pmAmmInstruction(FAN, M1)],
      loaded,
    })
    expect(tx.transaction.message.accountKeys).not.toContain(M1)
    expect(extractSwaps(tx, markets).map((s) => s.market)).toEqual([M1])
  })

  // A response whose instructions name keys it does not hold cannot be read in full: the count
  // must stop instead of dropping a swap.
  const unreadable = new Error(`transaction ${SIG} cannot be read in full`)

  it.each<[string, number, (ix: RawInstruction, past: number) => void]>([
    [
      'the program id of an instruction',
      0,
      (ix, past) => {
        ix.programIdIndex = past
      },
    ],
    [
      'an account of an instruction',
      1,
      (ix, past) => {
        ix.accounts[0] = past
      },
    ],
    [
      'the market of a swap',
      2,
      (ix, past) => {
        ix.accounts[1] = past
      },
    ],
  ])('throws when %s is past the resolved keys', (_name, i, change) => {
    const tx = structuredClone(trade({ lookup: true }))
    const { accountKeys, instructions } = tx.transaction.message
    // M1 is the one loaded key, right after the static keys.
    expect(instructions[2]?.accounts[1]).toBe(accountKeys.length)
    const ix = instructions[i]
    if (ix === undefined) throw new Error(`no instruction ${i}`)
    change(ix, accountKeys.length + 1)
    expect(() => extractSwaps(tx, markets)).toThrow(unreadable)
    expect(() => hasBotMemo(tx)).toThrow(unreadable)
  })

  it('throws when the signer of a swap is past the static keys', () => {
    // The header claims one signer more than the static keys hold, so a loaded key would pass
    // as the signer of the swap. A loaded key never signs.
    const tx = structuredClone(trade({ lookup: true }))
    const { header, accountKeys, instructions } = tx.transaction.message
    header.numRequiredSignatures = accountKeys.length + 1
    const swap = instructions[2]
    if (swap === undefined) throw new Error('no swap')
    swap.accounts[0] = accountKeys.length
    expect(() => extractSwaps(tx, markets)).toThrow(unreadable)
  })

  it('reads a swap whose data carries the discriminator and the 17 argument bytes', () => {
    const tx = rawTransaction({
      signature: SIG,
      blockTime: T0,
      signers: [FAN],
      instructions: [pmAmmInstruction(FAN, M1, swapData(3, 20_000_000n, 19_000_000n))],
    })
    expect(extractSwaps(tx, markets)).toHaveLength(1)
  })
})

describe('tests/fixtures/metrics/devnet-swaps.json', () => {
  // Two real getTransaction results from devnet: the unsponsored S1 swap (a legacy message) and
  // the sponsored S3a swap (v0, two signers).
  const devnet = JSON.parse(
    readFileSync(
      new URL('../../../../tests/fixtures/metrics/devnet-swaps.json', import.meta.url),
      'utf8',
    ),
  ) as Record<'s1' | 's3a', RawTransaction>
  const S1_MARKET = 'JBEvyrW6w6bbcGFnUuNdN5AdNBayiBRB4ggoFmX5D4tH'
  const S3A_MARKET = 'qpF2PseRguMvq4bK1jbWodfCapfCPFmrYcrNjMYj4AK'

  it('reads the unsponsored S1 swap', () => {
    expect(devnet.s1.version).toBe('legacy')
    expect(hasBotMemo(devnet.s1)).toBe(false)
    expect(extractSwaps(devnet.s1, new Set([S1_MARKET]))).toEqual([
      {
        signature:
          'dBvPN4uJhdZAGeoTWxZJNSkUCgVa5Cd2iuKi2QvYCD8Z6xEqsovLxQNoQN4t8Hn5er3GRbs2Z1APwXTv4y7HgGA',
        wallet: 'BqwvXe6H4ZgCgg6D2dSDVFkCrN79X8C6ZC6RDXB5soo',
        market: S1_MARKET,
        blockTime: 1794993225,
        botMemo: false,
      },
    ])
  })

  it('reads the sponsored S3a swap and takes the burner, not the sponsor that pays the fee', () => {
    const { message } = devnet.s3a.transaction
    expect(devnet.s3a.version).toBe(0)
    expect(message.header.numRequiredSignatures).toBe(2)
    expect(message.accountKeys[0]).toBe('32tQ3JDbnnQSqs51BDNzgcy82dW7AKK2EMKDo9ACBnrc')
    expect(hasBotMemo(devnet.s3a)).toBe(false)
    expect(extractSwaps(devnet.s3a, new Set([S3A_MARKET]))).toEqual([
      {
        signature:
          '5Pu68wzGKErA74ggUXS5UwE4Aov73RpSEvrEueBKCtTHZb4x6geA6Y7tZmZ3NvKBkJLKQ8psKK8MJqGa86cY2jBV',
        wallet: '9qbjWVkoA4Z9SSieAcBnzG8K4zj8F3M955w7spAjK2XW',
        market: S3A_MARKET,
        blockTime: 1794994260,
        botMemo: false,
      },
    ])
  })

  it('finds no swap when the market is not in the set', () => {
    expect(extractSwaps(devnet.s1, new Set([S3A_MARKET]))).toEqual([])
    expect(extractSwaps(devnet.s3a, new Set([S1_MARKET]))).toEqual([])
  })
})

describe('isRateBot', () => {
  const t = unix('2026-11-24T01:00:00Z')
  const every = (n: number, step: number) => Array.from({ length: n }, (_, i) => t + i * step)

  it('flags 20 swaps inside [t, t+300)', () => {
    expect(isRateBot([...every(19, 15), t + 299])).toBe(true)
  })

  it('does not flag 20 swaps spanning exactly 300 s', () => {
    expect(isRateBot([...every(19, 15), t + 300])).toBe(false)
  })

  it('does not flag 19 swaps in the same second', () => {
    expect(isRateBot(every(19, 0))).toBe(false)
  })

  it('flags 20 swaps in the same second', () => {
    expect(isRateBot(every(20, 0))).toBe(true)
  })

  it('finds a burst inside a longer history given newest first', () => {
    const history = [...every(5, 3_600), ...every(20, 14).map((s) => s + 50_000)].reverse()
    expect(isRateBot(history)).toBe(true)
  })

  it('does not flag 20 swaps an hour apart given newest first', () => {
    // Unsorted, every difference would be negative and so below 300.
    expect(isRateBot(every(20, 3_600).reverse())).toBe(false)
  })
})

const validFile = (): WalletsFile => ({
  version: 1,
  teamWallets: [
    { pubkey: walletKey('deployer'), role: 'deployer', addedAt: '2026-11-22' },
    { pubkey: walletKey('burner-1'), role: 'team-burner', addedAt: '2026-11-22T09:30:00Z' },
  ],
  excludedMarkets: [
    {
      gameMarket: gameMarketKey('rehearsal'),
      reason: 'rehearsal market',
      createSignature: fakeSignature('create/rehearsal'),
      addedAt: '2026-11-22',
    },
  ],
})

describe('validateWalletsFile', () => {
  it('accepts a valid file and an empty one', () => {
    expect(validateWalletsFile(validFile())).toEqual({ ok: true, value: validFile() })
    const empty = { version: 1, teamWallets: [], excludedMarkets: [] }
    expect(validateWalletsFile(empty)).toEqual({ ok: true, value: empty })
  })

  it('accepts every team role', () => {
    const roles: TeamRole[] = [
      'deployer',
      'creator',
      'sponsor',
      'attestor',
      'guardian-1',
      'guardian-2',
      'treasury',
      'squads-member',
      'team-burner',
      'spike',
    ]
    const teamWallets = roles.map((role) => ({
      pubkey: walletKey(role),
      role,
      addedAt: '2026-11-23',
    }))
    expect(validateWalletsFile({ ...validFile(), teamWallets }).ok).toBe(true)
  })

  const [deployer] = validFile().teamWallets
  const [rehearsal] = validFile().excludedMarkets
  const withTeam = (entry: Record<string, unknown>) => ({ ...validFile(), teamWallets: [entry] })
  const withExcluded = (entry: Record<string, unknown>) => ({
    ...validFile(),
    excludedMarkets: [entry],
  })
  const notUtc = (path: string) =>
    `${path}.addedAt: not a UTC date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)`
  const broken: [string, unknown, string][] = [
    ['a JSON array', [], 'the wallets file is not a JSON object'],
    ['version 2', { ...validFile(), version: 2 }, 'version: must be 1'],
    ['a missing list', { version: 1, teamWallets: [] }, 'excludedMarkets: must be an array'],
    ['an unknown root field', { ...validFile(), note: 'x' }, 'root: unknown field "note"'],
    [
      'a pubkey with a non-base58 character',
      withTeam({ ...deployer, pubkey: '0OIl' }),
      'teamWallets[0].pubkey: not a base58 pubkey',
    ],
    [
      'a 31-byte pubkey',
      withTeam({ ...deployer, pubkey: toBase58(new Uint8Array(31).fill(7)) }),
      'teamWallets[0].pubkey: not a base58 pubkey',
    ],
    [
      'an unknown role',
      withTeam({ ...deployer, role: 'founder' }),
      'teamWallets[0].role: unknown role',
    ],
    [
      'an impossible date',
      withTeam({ ...deployer, addedAt: '2026-02-30' }),
      notUtc('teamWallets[0]'),
    ],
    [
      'a date with a non-UTC offset',
      withTeam({ ...deployer, addedAt: '2026-11-22T09:00:00+02:00' }),
      notUtc('teamWallets[0]'),
    ],
    [
      'a date with milliseconds',
      withTeam({ ...deployer, addedAt: '2026-11-22T09:00:00.000Z' }),
      notUtc('teamWallets[0]'),
    ],
    [
      'an excluded market date with milliseconds',
      withExcluded({ ...rehearsal, addedAt: '2026-11-22T09:00:00.000Z' }),
      notUtc('excludedMarkets[0]'),
    ],
    [
      'an unknown wallet field',
      withTeam({ ...deployer, label: 'x' }),
      'teamWallets[0]: unknown field "label"',
    ],
    [
      'a wallet listed twice',
      { ...validFile(), teamWallets: [deployer, { ...deployer, role: 'creator' }] },
      'teamWallets[1].pubkey: listed twice',
    ],
    [
      'an empty reason',
      withExcluded({ ...rehearsal, reason: '  ' }),
      'excludedMarkets[0].reason: must be one non-empty line',
    ],
    [
      'a two-line reason',
      withExcluded({ ...rehearsal, reason: 'one\ntwo' }),
      'excludedMarkets[0].reason: must be one non-empty line',
    ],
    [
      'a 32-byte create signature',
      withExcluded({ ...rehearsal, createSignature: walletKey('x') }),
      'excludedMarkets[0].createSignature: not a base58 signature',
    ],
    [
      'a market listed twice',
      { ...validFile(), excludedMarkets: [rehearsal, { ...rehearsal, reason: 'again' }] },
      'excludedMarkets[1].gameMarket: listed twice',
    ],
  ]

  it.each(broken)('rejects %s', (_name, json, error) => {
    expect(validateWalletsFile(json)).toEqual({ ok: false, errors: [error] })
  })

  it('reports every error at once', () => {
    const result = validateWalletsFile({ ...withTeam({ ...deployer, role: 'x' }), version: 0 })
    expect(result).toEqual({
      ok: false,
      errors: ['version: must be 1', 'teamWallets[0].role: unknown role'],
    })
  })
})

describe('checkAppendOnly', () => {
  const burner2 = {
    pubkey: walletKey('burner-2'),
    role: 'team-burner',
    addedAt: '2026-11-25',
  } as const

  it('accepts an unchanged file and appended entries', () => {
    const next = validFile()
    next.teamWallets.push(burner2)
    next.excludedMarkets.push({
      gameMarket: gameMarketKey('test-2'),
      reason: 'team test market',
      createSignature: fakeSignature('create/test-2'),
      addedAt: '2026-11-25',
    })
    expect(checkAppendOnly(validFile(), validFile())).toEqual([])
    expect(checkAppendOnly(validFile(), next)).toEqual([])
  })

  it('reports a removed wallet', () => {
    const next = validFile()
    next.teamWallets.pop()
    expect(checkAppendOnly(validFile(), next)).toEqual(['teamWallets[1]: removed'])
  })

  it('reports a changed role', () => {
    const next = validFile()
    next.teamWallets = next.teamWallets.map((w, i) => (i === 0 ? { ...w, role: 'creator' } : w))
    expect(checkAppendOnly(validFile(), next)).toEqual(['teamWallets[0]: changed'])
  })

  it('reports an entry inserted before the others', () => {
    const next = validFile()
    next.teamWallets.unshift(burner2)
    expect(checkAppendOnly(validFile(), next)).toEqual([
      'teamWallets[0]: changed',
      'teamWallets[1]: changed',
    ])
  })

  it('reports an edited and a removed excluded market', () => {
    const edited = validFile()
    edited.excludedMarkets = edited.excludedMarkets.map((e) => ({ ...e, reason: 'other' }))
    expect(checkAppendOnly(validFile(), edited)).toEqual(['excludedMarkets[0]: changed'])
    const removed = { ...validFile(), excludedMarkets: [] }
    expect(checkAppendOnly(validFile(), removed)).toEqual(['excludedMarkets[0]: removed'])
  })
})

describe('countFans', () => {
  const nba = (label: string, game: string, tipoff: string, kind = 0): SeasonMarket => ({
    label,
    kind,
    league: 'NBA',
    game,
    tipoff,
  })
  const G1 = nba('g1', '401810001', '2026-11-27T19:30:00-05:00')
  const G1_CLUTCH = nba('g1-clutch', '401810001', '2026-11-27T19:30:00-05:00', 2)
  const G1_HALF = nba('g1-half', '401810001', '2026-11-27T19:30:00-05:00', 1)
  const G2 = nba('g2', '401810002', '2026-11-27T22:30:00-05:00')
  const G3 = nba('g3', '401810003', '2026-11-29T19:00:00-05:00')
  const G4 = nba('g4', '401810004', '2026-12-02T20:00:00-05:00')
  const PRE = nba('pre', '401810000', '2026-11-26T19:00:00-05:00')
  const PRACTICE: SeasonMarket = {
    label: 'practice',
    kind: 0,
    league: 'PRACTICE',
    game: 'p-0001',
    tipoff: '2026-11-28T12:00:00-05:00',
  }
  const ALL = [G1, G1_CLUTCH, G1_HALF, G2, G3, G4, PRE, PRACTICE]
  const T = unix('2026-11-28T00:40:00Z')
  const at = (minutes: number) => iso(T + minutes * 60)
  const zero = { wallets: 0, firstTrade: 0, returning: 0, threeNightFans: 0, engaged: 0 }

  it('gives zeros on empty data and still lists the excluded markets', () => {
    const report = count({
      markets: [],
      swaps: [],
      excluded: [{ market: 'never-created', reason: 'team test market' }],
    })
    expect(report).toEqual({
      window: { first: '2026-11-27', last: '2026-12-10' },
      markets: { counted: 0, excluded: 0, ignored: 0 },
      swaps: { counted: 0, nightTouches: 0 },
      classes: { human: zero, bot: zero, team: zero },
      bots: { memo: 0, rate: 0 },
      nights: WINDOW_NIGHTS.map((night) => ({
        night,
        human: 0,
        bot: 0,
        team: 0,
        touches: { human: 0, bot: 0, team: 0 },
      })),
      excluded: [
        { gameMarket: gameMarketKey('never-created'), reason: 'team test market', nonTeamSwaps: 0 },
      ],
      threeNightFans: 0,
    })
    expect(report.nights).toHaveLength(14)
  })

  it('puts a swap made after midnight ET on the night of its tipoff', () => {
    // G2 tips off at 22:30 ET on 2026-11-27; the swap is at 00:30 ET on 2026-11-28.
    const report = count({ markets: [G2], swaps: [['fan', 'g2', '2026-11-28T05:30:00Z']] })
    expect(nightRow(report, '2026-11-27')).toEqual({
      night: '2026-11-27',
      human: 1,
      bot: 0,
      team: 0,
      touches: { human: 1, bot: 0, team: 0 },
    })
    expect(nightRow(report, '2026-11-28')?.human).toBe(0)
    expect(nightRow(report, '2026-11-28')?.touches.human).toBe(0)
  })

  it('counts a swap made after midnight ET on the last night, on the night after the window', () => {
    // The game tips off at 22:30 ET on 2026-12-10; the swap is at 00:30 ET on 2026-12-11.
    const last = nba('last', '401810098', '2026-12-10T22:30:00-05:00')
    const report = count({ markets: [last], swaps: [['fan', 'last', '2026-12-11T05:30:00Z']] })
    expect(report.swaps).toEqual({ counted: 1, nightTouches: 1 })
    expect(report.classes.human).toEqual({ ...zero, wallets: 1, firstTrade: 1 })
    expect(nightRow(report, '2026-12-10')).toEqual({
      night: '2026-12-10',
      human: 1,
      bot: 0,
      team: 0,
      touches: { human: 1, bot: 0, team: 0 },
    })
    expect(nightRow(report, '2026-12-11')).toBeUndefined()
  })

  it('takes the night from the tipoff, never from the block time', () => {
    const report = count({
      markets: [PRE, G4],
      swaps: [
        ['early', 'g4', '2026-11-24T15:00:00Z'], // before the window, on a market of 2026-12-02
        ['late', 'pre', '2026-11-27T20:00:00Z'], // inside the window, on a market of 2026-11-26
      ],
    })
    expect(report.swaps).toEqual({ counted: 2, nightTouches: 1 })
    expect(report.classes.human).toEqual({ ...zero, wallets: 2, firstTrade: 1 })
    expect(nightRow(report, '2026-12-02')?.human).toBe(1)
    expect(nightRow(report, '2026-11-27')?.human).toBe(0)
    expect(nightRow(report, '2026-12-02')?.touches.human).toBe(1)
    expect(nightRow(report, '2026-11-27')?.touches.human).toBe(0)
  })

  it('counts the first and last nights of the window and nothing outside it', () => {
    const edges = [
      nba('e0', '401810090', '2026-11-26T23:59:00-05:00'),
      nba('e1', '401810091', '2026-11-27T00:00:00-05:00'),
      nba('e2', '401810092', '2026-12-10T23:59:00-05:00'),
      nba('e3', '401810093', '2026-12-11T00:00:00-05:00'),
    ]
    const report = count({
      markets: edges,
      swaps: edges.map((m, i): SeasonSwap => [`fan-${i}`, m.label, '2026-11-24T12:00:00Z']),
    })
    expect(report.swaps).toEqual({ counted: 4, nightTouches: 2 })
    expect(report.classes.human).toEqual({ ...zero, wallets: 4, firstTrade: 2 })
    expect(report.nights.filter((n) => n.human > 0).map((n) => n.night)).toEqual([
      '2026-11-27',
      '2026-12-10',
    ])
    expect(report.nights.map((n) => n.human)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    expect(report.nights.map((n) => n.touches.human)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ])
  })

  it('ignores kind 1 and PRACTICE markets', () => {
    const report = count({
      markets: [G1_HALF, PRACTICE],
      swaps: [
        ['fan', 'g1-half', at(0)],
        ['fan', 'practice', at(1)],
      ],
    })
    expect(report.markets).toEqual({ counted: 0, excluded: 0, ignored: 2 })
    expect(report.swaps).toEqual({ counted: 0, nightTouches: 0 })
    expect(report.classes.human).toEqual(zero)
  })

  it('puts a kind 2 market on the night and the game of its kind 0 market', () => {
    const report = count({
      markets: [G1, G1_CLUTCH],
      swaps: [
        ['fan', 'g1', at(0)],
        ['fan', 'g1-clutch', at(135)],
        ['fan', 'g1-clutch', at(137)],
      ],
    })
    expect(report.markets.counted).toBe(2)
    expect(report.swaps.nightTouches).toBe(3)
    expect(report.classes.human).toEqual({ ...zero, wallets: 1, firstTrade: 1 })
    expect(report.nights.filter((n) => n.human > 0).map((n) => n.night)).toEqual(['2026-11-27'])
  })

  it.each([
    ['3 swaps on 2 games', ['g1', 'g1', 'g2'], 1],
    ['3 swaps on 1 game, kind 0 and kind 2', ['g1', 'g1-clutch', 'g1'], 0],
    ['2 swaps on 2 games', ['g1', 'g2'], 0],
  ])('engaged: %s -> %i', (_name, markets, engaged) => {
    const report = count({
      markets: ALL,
      swaps: markets.map((m, i): SeasonSwap => ['fan', m, at(i)]),
    })
    expect(report.classes.human.engaged).toBe(engaged)
  })

  it('counts only night touches toward engaged', () => {
    const report = count({
      markets: [PRE, G1, G2],
      swaps: [
        // 3 night touches on one game, and a swap on another game before the window.
        ['one-game', 'g1', at(0)],
        ['one-game', 'g1', at(1)],
        ['one-game', 'g1', at(2)],
        ['one-game', 'pre', '2026-11-27T00:30:00Z'],
        // 2 night touches on two games, and a third swap before the window.
        ['two-touches', 'g1', at(3)],
        ['two-touches', 'g2', at(4)],
        ['two-touches', 'pre', '2026-11-27T00:31:00Z'],
      ],
    })
    expect(report.classes.human).toEqual({ ...zero, wallets: 2, firstTrade: 2 })
  })

  it('counts first-trade, returning and 3-night fans by distinct nights', () => {
    const report = count({
      markets: ALL,
      swaps: [
        ['three', 'g1', at(0)],
        ['three', 'g3', '2026-11-30T00:30:00Z'],
        ['three', 'g4', '2026-12-03T01:30:00Z'],
        ['two', 'g1', at(1)],
        ['two', 'g2', at(2)], // same night as g1
        ['two', 'g3', '2026-11-30T00:31:00Z'],
        ['one', 'g1', at(3)],
        ['one', 'g2', at(4)],
      ],
    })
    expect(report.classes.human).toEqual({
      wallets: 3,
      firstTrade: 3,
      returning: 2,
      threeNightFans: 1,
      engaged: 2,
    })
    expect(report.threeNightFans).toBe(1)
    expect(nightRow(report, '2026-11-27')?.human).toBe(3)
    expect(nightRow(report, '2026-11-29')?.human).toBe(2)
    expect(nightRow(report, '2026-12-02')?.human).toBe(1)
  })

  it('counts each swap as a night touch and each wallet once a night', () => {
    const report = count({
      markets: ALL,
      swaps: [
        // 2 swaps on one night: 1 wallet and 2 night touches there.
        ['twice', 'g1', at(0)],
        ['twice', 'g2', at(1)],
        ['twice', 'g3', '2026-11-30T00:30:00Z'],
        ['once', 'g1', at(2)],
      ],
    })
    expect(report.swaps).toEqual({ counted: 4, nightTouches: 4 })
    expect(nightRow(report, '2026-11-27')).toEqual({
      night: '2026-11-27',
      human: 2,
      bot: 0,
      team: 0,
      touches: { human: 3, bot: 0, team: 0 },
    })
    expect(nightRow(report, '2026-11-29')).toEqual({
      night: '2026-11-29',
      human: 1,
      bot: 0,
      team: 0,
      touches: { human: 1, bot: 0, team: 0 },
    })
  })

  it('puts only night touches in the per-night table', () => {
    const post = nba('post', '401810099', '2026-12-11T19:00:00-05:00')
    const report = count({
      markets: [PRE, G1, post],
      swaps: [
        ['fan', 'pre', '2026-11-27T00:30:00Z', { repeat: 3, every: 60 }],
        ['fan', 'g1', at(0)],
        ['early', 'pre', '2026-11-27T00:40:00Z'],
        ['late', 'post', '2026-12-12T00:30:00Z'],
      ],
    })
    expect(report.swaps).toEqual({ counted: 6, nightTouches: 1 })
    expect(report.nights.map((n) => n.touches)).toEqual(
      WINDOW_NIGHTS.map((night) => ({ human: night === '2026-11-27' ? 1 : 0, bot: 0, team: 0 })),
    )
    expect(report.nights.map((n) => n.human)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('puts night touches under the class of their wallet: team, then bot, then human', () => {
    const report = count({
      team: [{ wallet: 'burner', role: 'team-burner' }],
      markets: [G1, G3],
      swaps: [
        // A team wallet that sends the bot memo stays team.
        ['burner', 'g1', at(0), { memo: 'exact' }],
        ['burner', 'g1', at(1)],
        ['memo-bot', 'g1', at(2), { memo: 'exact' }],
        ['memo-bot', 'g1', at(3), { repeat: 2, every: 60 }],
        ['fan', 'g1', at(4)],
        ['fast', 'g3', '2026-11-30T00:30:00Z', { repeat: 20, every: 10 }],
      ],
    })
    expect(report.bots).toEqual({ memo: 1, rate: 1 })
    expect(nightRow(report, '2026-11-27')).toEqual({
      night: '2026-11-27',
      human: 1,
      bot: 1,
      team: 1,
      touches: { human: 1, bot: 3, team: 2 },
    })
    expect(nightRow(report, '2026-11-29')).toEqual({
      night: '2026-11-29',
      human: 0,
      bot: 1,
      team: 0,
      touches: { human: 0, bot: 20, team: 0 },
    })
  })

  it('never adds a night touch from an excluded market', () => {
    const rehearsal = nba('rehearsal', '401810010rh1', '2026-11-27T14:00:00-05:00')
    const report = count({
      team: [{ wallet: 'ops', role: 'attestor' }],
      excluded: [{ market: 'rehearsal', reason: 'rehearsal market' }],
      markets: [G1, rehearsal],
      swaps: [
        ['fan', 'rehearsal', '2026-11-27T19:10:00Z', { repeat: 3, every: 60 }],
        ['ops', 'rehearsal', '2026-11-27T19:20:00Z'],
        ['fan', 'g1', at(0)],
        ['ops', 'g1', at(1)],
      ],
    })
    expect(report.swaps).toEqual({ counted: 2, nightTouches: 2 })
    expect(report.excluded.map((e) => e.nonTeamSwaps)).toEqual([3])
    expect(nightRow(report, '2026-11-27')).toEqual({
      night: '2026-11-27',
      human: 1,
      bot: 0,
      team: 1,
      touches: { human: 1, bot: 0, team: 1 },
    })
  })

  it('keeps a team wallet in the team class even when it acts like a bot', () => {
    const report = count({
      team: [{ wallet: 'burner', role: 'team-burner' }],
      markets: [G1],
      swaps: [['burner', 'g1', at(0), { repeat: 20, every: 5, memo: 'exact' }]],
    })
    expect(report.classes.team).toEqual({ ...zero, wallets: 1, firstTrade: 1 })
    expect(report.classes.bot).toEqual(zero)
    expect(report.bots).toEqual({ memo: 0, rate: 0 })
    expect(nightRow(report, '2026-11-27')).toEqual({
      night: '2026-11-27',
      human: 0,
      bot: 0,
      team: 1,
      touches: { human: 0, bot: 0, team: 20 },
    })
  })

  it('counts the swap signer, not the team sponsor that pays the fee', () => {
    const report = count({
      team: [{ wallet: 'sponsor', role: 'sponsor' }],
      markets: [G1],
      swaps: [['fan', 'g1', at(0), { sponsored: true }]],
    })
    expect(report.classes.human.wallets).toBe(1)
    expect(report.classes.team.wallets).toBe(0)
  })

  it.each([
    ['exact', 'bot'],
    ['with-account', 'human'],
    ['wrong-text', 'human'],
    ['legacy-program', 'human'],
    ['inner', 'human'],
  ] as const)('a %s memo makes the wallet a %s', (memo, walletClass) => {
    const report = count({
      markets: [G1, G2],
      swaps: [
        ['fan', 'g1', at(0), { memo }],
        ['fan', 'g2', at(1)],
      ],
    })
    expect(report.classes[walletClass]).toEqual({ ...zero, wallets: 1, firstTrade: 1 })
    expect(report.bots).toEqual({ memo: walletClass === 'bot' ? 1 : 0, rate: 0 })
  })

  it('makes a memo bot from a memo swap on a counted market outside the window', () => {
    const report = count({
      markets: [PRE, G1],
      swaps: [
        ['fan', 'pre', '2026-11-27T00:30:00Z', { memo: 'exact' }],
        ['fan', 'g1', at(0)],
      ],
    })
    expect(report.bots).toEqual({ memo: 1, rate: 0 })
    expect(report.classes.bot).toEqual({ ...zero, wallets: 1, firstTrade: 1 })
    expect(report.classes.human).toEqual(zero)
  })

  // Newest first, the order in which getSignaturesForAddress lists them.
  const burst = (offsets: number[]): SeasonSwap[] =>
    [...offsets].reverse().map((s) => ['fast', 'g1', iso(T + s)])
  const every = (n: number, step: number) => Array.from({ length: n }, (_, i) => i * step)

  it.each([
    ['20 swaps inside [t, t+300) make a rate bot', [...every(19, 15), 299], 1],
    ['20 swaps spanning exactly 300 s do not', [...every(19, 15), 300], 0],
    ['19 swaps in the same second do not', every(19, 0), 0],
  ])('%s', (_name, offsets, rate) => {
    const report = count({ markets: [G1], swaps: burst(offsets) })
    expect(report.bots).toEqual({ memo: 0, rate })
    expect(report.classes.bot.wallets).toBe(rate)
    expect(report.classes.human.wallets).toBe(1 - rate)
  })

  it('counts swaps outside the window for the rate rule', () => {
    const report = count({
      markets: [PRE, G1],
      swaps: [
        ['fast', 'pre', '2026-11-27T00:10:00Z', { repeat: 20, every: 10 }],
        ['fast', 'g1', at(0)],
      ],
    })
    expect(report.bots).toEqual({ memo: 0, rate: 1 })
    expect(report.classes.bot).toEqual({ ...zero, wallets: 1, firstTrade: 1 })
    expect(report.classes.human).toEqual(zero)
  })

  it('counts a wallet that is both a memo bot and a rate bot once under each reason', () => {
    const report = count({
      markets: [G1],
      swaps: [['both', 'g1', at(0), { repeat: 20, every: 5, memo: 'exact' }]],
    })
    expect(report.bots).toEqual({ memo: 1, rate: 1 })
    expect(report.classes.bot).toEqual({ ...zero, wallets: 1, firstTrade: 1 })
  })

  it('reports non-team swaps on an excluded market and counts them nowhere else', () => {
    const rehearsal = nba('rehearsal', '401810010rh1', '2026-11-28T14:00:00-05:00')
    const report = count({
      team: [{ wallet: 'ops', role: 'attestor' }],
      excluded: [{ market: 'rehearsal', reason: 'rehearsal market' }],
      markets: [G1, rehearsal],
      swaps: [
        ['outsider', 'rehearsal', '2026-11-28T19:10:00Z', { repeat: 20, every: 5, memo: 'exact' }],
        ['ops', 'rehearsal', '2026-11-28T19:00:00Z'],
        ['outsider', 'g1', at(0)],
      ],
    })
    expect(report.markets).toEqual({ counted: 1, excluded: 1, ignored: 0 })
    expect(report.excluded).toEqual([
      { gameMarket: gameMarketKey('rehearsal'), reason: 'rehearsal market', nonTeamSwaps: 20 },
    ])
    expect(report.swaps).toEqual({ counted: 1, nightTouches: 1 })
    // 20 fast memo swaps on the excluded market make the outsider neither a memo nor a rate bot.
    expect(report.bots).toEqual({ memo: 0, rate: 0 })
    expect(report.classes.human).toEqual({ ...zero, wallets: 1, firstTrade: 1 })
    expect(report.classes.team).toEqual(zero)
    expect(nightRow(report, '2026-11-28')).toEqual({
      night: '2026-11-28',
      human: 0,
      bot: 0,
      team: 0,
      touches: { human: 0, bot: 0, team: 0 },
    })
  })

  it('treats a listed market as excluded whatever its kind', () => {
    const report = count({
      excluded: [{ market: 'g1-half', reason: 'team test market' }],
      markets: [G1_HALF],
      swaps: [['fan', 'g1-half', at(0)]],
    })
    expect(report.markets).toEqual({ counted: 0, excluded: 1, ignored: 0 })
    expect(report.excluded.map((e) => e.nonTeamSwaps)).toEqual([1])
  })

  it('counts two swaps of one transaction as two', () => {
    const report = count({
      markets: [G1, G2],
      swaps: [
        ['fan', 'g1', at(0), { tx: 'both' }],
        ['fan', 'g2', at(0), { tx: 'both' }],
        ['fan', 'g1', at(5)],
      ],
    })
    expect(report.swaps).toEqual({ counted: 3, nightTouches: 3 })
    expect(report.classes.human).toEqual({ ...zero, wallets: 1, firstTrade: 1, engaged: 1 })
  })

  it('ignores a swap on a market that no GameMarket points to', () => {
    const report = countFans({
      markets: [],
      swaps: [
        {
          signature: fakeSignature('x'),
          wallet: walletKey('fan'),
          market: pmAmmMarketKey('unknown'),
          blockTime: T,
          botMemo: true,
        },
      ],
      wallets: { version: 1, teamWallets: [], excludedMarkets: [] },
    })
    expect(report.swaps).toEqual({ counted: 0, nightTouches: 0 })
    expect(report.classes.bot).toEqual(zero)
    expect(report.classes.human).toEqual(zero)
  })
})

interface SeasonFixture {
  season: Season
  expected: Omit<FanReport, 'excluded'> & {
    excluded: { market: string; reason: string; nonTeamSwaps: number }[]
  }
}

const seasonBasic = JSON.parse(
  readFileSync(
    new URL('../../../../tests/fixtures/metrics/season-basic.json', import.meta.url),
    'utf8',
  ),
) as SeasonFixture

describe('tests/fixtures/metrics/season-basic.json', () => {
  it('builds a valid wallets file', () => {
    expect(validateWalletsFile(seasonChain(seasonBasic.season).wallets).ok).toBe(true)
  })

  it('reproduces its expected report', () => {
    const { excluded, ...expected } = seasonBasic.expected
    expect(count(seasonBasic.season)).toEqual({
      ...expected,
      excluded: excluded.map(({ market, ...rest }) => ({
        gameMarket: gameMarketKey(market),
        ...rest,
      })),
    })
  })
})

describe('formatReport', () => {
  it('prints the headline, both tables, the excluded markets and the elapsed time', () => {
    const text = formatReport(count(seasonBasic.season), {
      rpc: 'http://127.0.0.1:8899',
      elapsedMs: 83_240,
    })
    expect(text).toContain('rpc: http://127.0.0.1:8899')
    expect(text).toContain('window: ET nights 2026-11-27 to 2026-12-10')
    expect(text).toContain('markets: 8 counted, 1 excluded, 2 ignored')
    expect(text).toContain('swaps: 107 on counted markets, 81 night touches')
    expect(text).toContain('3-Night Fans (human wallets): 1')
    expect(text).toMatch(/^class +wallets +first-trade +returning +3-night +engaged$/m)
    expect(text).toMatch(/^human +10 +9 +4 +1 +2$/m)
    expect(text).toMatch(/^bot +3 +3 +1 +0 +0$/m)
    expect(text).toMatch(/^team +1 +1 +1 +0 +1$/m)
    expect(text).toContain('bot wallets by reason: memo 2, rate 1')
    expect(text).toContain(
      '\nper ET night: wallets with a night touch, then night touches\n' +
        'night (ET)  human  bot  team  human touches  bot touches  team touches\n',
    )
    expect(text).toMatch(/^2026-11-27 +6 +1 +1 +12 +1 +1$/m)
    expect(text).toMatch(/^2026-11-28 +0 +0 +0 +0 +0 +0$/m)
    expect(text).toMatch(/^2026-11-29 +4 +2 +1 +40 +2 +20$/m)
    expect(text).toMatch(/^2026-12-02 +3 +1 +0 +3 +1 +0$/m)
    expect(text).toMatch(/^2026-12-10 +1 +0 +0 +1 +0 +0$/m)
    expect(text).not.toMatch(/^2026-11-26 /m)
    expect(text).not.toMatch(/^2026-12-11 /m)
    expect(text).toContain('excluded markets: 1 listed in the wallets file, 1 on chain')
    expect(text).toContain(
      `  ${gameMarketKey('rehearsal')}  non-team swaps: 21  reason: rehearsal market inside the window`,
    )
    expect(text.split('\n').at(-1)).toBe('elapsed: 83.2 s')
  })

  it('prints zeros for empty data and an excluded market not on chain', () => {
    const report = count({
      markets: [],
      swaps: [],
      excluded: [{ market: 'never-created', reason: 'team test market' }],
    })
    const text = formatReport(report, { rpc: DEFAULT_RPC, elapsedMs: 0 })
    expect(text).toContain('markets: 0 counted, 0 excluded, 0 ignored')
    expect(text).toContain('3-Night Fans (human wallets): 0')
    for (const night of WINDOW_NIGHTS) {
      expect(text).toMatch(new RegExp(`^${night} +0 +0 +0 +0 +0 +0$`, 'm'))
    }
    // The per-night table lists exactly the nights of the window, in order.
    expect(text.match(/^\d{4}-\d{2}-\d{2}(?= )/gm)).toEqual(WINDOW_NIGHTS)
    expect(text).toContain('excluded markets: 1 listed in the wallets file, 0 on chain')
    expect(text).toContain(
      `  ${gameMarketKey('never-created')}  non-team swaps: 0  reason: team test market`,
    )
    expect(text.split('\n').at(-1)).toBe('elapsed: 0.0 s')
    const none = formatReport(count({ markets: [], swaps: [] }), { rpc: DEFAULT_RPC, elapsedMs: 0 })
    expect(none).toContain('excluded markets: 0 listed in the wallets file, 0 on chain')
  })
})
