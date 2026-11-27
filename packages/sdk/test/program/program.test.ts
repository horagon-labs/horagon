import { createHash } from 'node:crypto'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { describe, expect, it } from 'vitest'
import { HoragonError } from '../../src/errors'
import { DEVNET_MUSDC_MINT, deriveMarketPda, PM_AMM_PROGRAM_ID } from '../../src/pm-amm'
import {
  buildCreateGameMarketIx,
  buildInitializeConfigIx,
  buildProposeResultIx,
  buildUpdateConfigIx,
  decodeGameMarket,
  deriveAuthority,
  failedProgramError,
  HORAGON_EVENT_DISCRIMINATORS,
  HORAGON_PROGRAM_ID,
  HoragonProgram,
  horagonErrorName,
  horagonInstructionName,
  marketAddresses,
  marketIdFor,
  marketName,
  parseHoragonEvents,
  randomMarketId,
} from '../../src/program'
import { key } from './idl-borsh'

const nodeMarketId = (text: string) => createHash('sha256').update(text).digest().readBigUInt64LE(0)

describe('marketIdFor', () => {
  it('is the first 8 bytes of sha256 read as u64 LE (spec 5.1)', async () => {
    expect(await marketIdFor('NBA', '401910007', 0)).toBe(
      nodeMarketId('horagon:v1:NBA:401910007:0'),
    )
    expect(await marketIdFor('NBA', '401910007', 1)).toBe(
      nodeMarketId('horagon:v1:NBA:401910007:1'),
    )
  })

  it('appends :salt + n for n in 1..9 and rejects anything else', async () => {
    expect(await marketIdFor('NBA', '401910007', 0, 3)).toBe(
      nodeMarketId('horagon:v1:NBA:401910007:0:salt3'),
    )
    await expect(marketIdFor('NBA', '1', 0, 10)).rejects.toThrow(HoragonError)
  })
})

describe('randomMarketId', () => {
  it('reads 8 random bytes as u64 LE and never answers 0', () => {
    const draws = [new Uint8Array(8), Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0x80])]
    const fill = (b: Uint8Array) => {
      b.set(draws.shift() ?? new Uint8Array(8))
      return b
    }
    // An all-zero draw is drawn again.
    expect(randomMarketId(fill)).toBe(0x8000_0000_0000_0001n)
  })

  it('is a different u64 each time with the default source', () => {
    const ids = new Set(Array.from({ length: 64 }, () => randomMarketId()))
    expect(ids.size).toBe(64)
    for (const id of ids) expect(id > 0n && id < 2n ** 64n).toBe(true)
  })
})

describe('marketName', () => {
  it('formats HRG NBA {AWAY}@{HOME} {MMDD} {W|H2}', () => {
    expect(
      marketName({ league: 'NBA', away: 'BOS', home: 'LAL', gameDate: '2026-11-19', kind: 0 }),
    ).toBe('HRG NBA BOS@LAL 1119 W')
    expect(
      marketName({ league: 'NBA', away: 'GSW', home: 'NYK', gameDate: '2026-12-01', kind: 1 }),
    ).toBe('HRG NBA GSW@NYK 1201 H2')
  })

  it('rejects a malformed date', () => {
    expect(() =>
      marketName({ league: 'NBA', away: 'A', home: 'B', gameDate: '19/11', kind: 0 }),
    ).toThrow(HoragonError)
  })
})

describe('addresses', () => {
  it('derives the pm-AMM market from market_id and the Authority ATAs off-curve', () => {
    const a = marketAddresses(77n)
    expect(a.market.equals(deriveMarketPda(77n, PM_AMM_PROGRAM_ID))).toBe(true)
    expect(a.authority.equals(deriveAuthority())).toBe(true)
    expect(a.authorityYes.equals(getAssociatedTokenAddressSync(a.yesMint, a.authority, true))).toBe(
      true,
    )
    expect(PublicKey.isOnCurve(a.authority.toBytes())).toBe(false)
  })

  it('HoragonProgram.halt prepends the two idempotent ATA creates', () => {
    const hp = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })
    const ixs = hp.ix.halt({ signer: key(3), marketId: 77n }, key(3))
    expect(ixs).toHaveLength(3)
    expect(ixs[2] && horagonInstructionName(ixs[2].data)).toBe('halt')
    expect(ixs[0]?.keys[1]?.pubkey.equals(hp.addresses(77n).authorityYes)).toBe(true)
  })
})

describe('instruction guards', () => {
  const base = {
    attestor: key(3),
    collateralMint: DEVNET_MUSDC_MINT,
    marketId: 1n,
    kind: 0 as const,
    league: 'NBA',
    externalGameId: '401910007',
    home: 'LAL',
    away: 'BOS',
    scheduledTipoff: 1,
    endTs: 2,
    name: 'HRG NBA BOS@LAL 1119 W',
    initialPriceBps: 5_000,
    seedAmount: 1n,
  }

  it.each([
    ['price below 500 bps', { initialPriceBps: 499 }],
    ['price above 9500 bps', { initialPriceBps: 9_501 }],
    ['zero seed', { seedAmount: 0n }],
    ['external id over 16 bytes', { externalGameId: '12345678901234567' }],
    ['lowercase tricode', { home: 'lal' }],
    ['5-letter tricode', { away: 'BOSTO' }],
    ['name over 32 bytes', { name: 'X'.repeat(33) }],
  ])('create rejects %s', (_, patch) => {
    expect(() => buildCreateGameMarketIx({ ...base, ...patch })).toThrow(HoragonError)
  })

  it('propose rejects a zero hash and a URI over 128 bytes', () => {
    const p = {
      signer: key(3),
      marketId: 1n,
      outcome: 'yes' as const,
      evidenceUri: 'https://x.test/e',
    }
    expect(() => buildProposeResultIx({ ...p, evidenceHash: new Uint8Array(32) })).toThrow(
      HoragonError,
    )
    expect(() =>
      buildProposeResultIx({
        ...p,
        evidenceHash: new Uint8Array(32).fill(1),
        evidenceUri: `https://${'a'.repeat(130)}`,
      }),
    ).toThrow(HoragonError)
  })
})

describe('dispute window bounds', () => {
  const init = {
    admin: key(1),
    attestor: key(3),
    guardians: [key(4), key(5)] as [PublicKey, PublicKey],
    collateralMint: DEVNET_MUSDC_MINT,
  }

  it('initialize_config rejects a window under 60 s or over 7 days and accepts the edges', () => {
    expect(() => buildInitializeConfigIx({ ...init, disputeWindowSecs: 59 })).toThrow(
      'dispute window below 60 s',
    )
    expect(() => buildInitializeConfigIx({ ...init, disputeWindowSecs: 7 * 86_400 + 1 })).toThrow(
      HoragonError,
    )
    expect(() => buildInitializeConfigIx({ ...init, disputeWindowSecs: 60 })).not.toThrow()
    expect(() => buildInitializeConfigIx({ ...init, disputeWindowSecs: 7 * 86_400 })).not.toThrow()
  })

  it('update_config applies the same bounds when a window is given', () => {
    expect(() => buildUpdateConfigIx({ admin: key(1), disputeWindowSecs: 59 })).toThrow(
      'dispute window below 60 s',
    )
    expect(() => buildUpdateConfigIx({ admin: key(1), disputeWindowSecs: 7 * 86_400 + 1 })).toThrow(
      HoragonError,
    )
    expect(() => buildUpdateConfigIx({ admin: key(1), disputeWindowSecs: 60 })).not.toThrow()
    expect(() => buildUpdateConfigIx({ admin: key(1), creationPaused: true })).not.toThrow()
  })
})

describe('decodeGameMarket', () => {
  it('refuses an account owned by another program', () => {
    expect(() => decodeGameMarket({ owner: PM_AMM_PROGRAM_ID, data: new Uint8Array(400) })).toThrow(
      /not owned/,
    )
  })

  it('refuses a wrong discriminator', () => {
    expect(() =>
      decodeGameMarket({ owner: HORAGON_PROGRAM_ID, data: new Uint8Array(400) }),
    ).toThrow(/not a GameMarket/)
  })
})

describe('parseHoragonEvents', () => {
  const recycled = Buffer.concat([
    Buffer.from(HORAGON_EVENT_DISCRIMINATORS.MarketRecycled),
    key(1).toBuffer(),
    key(2).toBuffer(),
    Buffer.from([5, 0, 0, 0, 0, 0, 0, 0]),
  ]).toString('base64')
  const id = HORAGON_PROGRAM_ID.toBase58()
  const pm = PM_AMM_PROGRAM_ID.toBase58()

  it('keeps horagon events and skips data logged inside a pm-AMM CPI', () => {
    const logs = [
      `Program ${id} invoke [1]`,
      `Program ${pm} invoke [2]`,
      `Program data: ${recycled}`,
      `Program ${pm} success`,
      `Program data: ${recycled}`,
      `Program ${id} success`,
    ]
    const events = parseHoragonEvents(logs)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'MarketRecycled', recovered: 5n })
  })

  it('ignores data lines outside any horagon frame', () => {
    expect(parseHoragonEvents([`Program ${pm} invoke [1]`, `Program data: ${recycled}`])).toEqual(
      [],
    )
  })
})

describe('failedProgramError', () => {
  const id = HORAGON_PROGRAM_ID.toBase58()
  const pm = PM_AMM_PROGRAM_ID.toBase58()

  it('names a horagon error by code', () => {
    expect(failedProgramError([`Program ${id} failed: custom program error: 0x1775`])).toEqual({
      program: 'horagon',
      code: 6005,
      name: 'BadStatus',
    })
    expect(horagonErrorName(6000)).toBe('Unauthorized')
    expect(horagonErrorName(6100)).toBeUndefined()
  })

  it('returns an Anchor framework code from horagon without a name', () => {
    expect(failedProgramError([`Program ${id} failed: custom program error: 0x7d6`])).toEqual({
      program: 'horagon',
      code: 2006,
    })
  })

  it('attributes a CPI failure to pm-AMM, which logs first', () => {
    expect(
      failedProgramError([
        `Program ${pm} failed: custom program error: 0x1773`,
        `Program ${id} failed: custom program error: 0x1773`,
      ]),
    ).toEqual({ program: 'pm-amm', code: 6003 })
  })
})
