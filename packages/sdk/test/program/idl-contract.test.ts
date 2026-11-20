// The SDK encodes `horagon` by hand; this file holds it to the IDL that `anchor build`
// generates (packages/sdk/idl/horagon.json). Any drift in account order, signer or writable
// flags, argument layout, account layout, events or error order fails here.
import { PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { describe, expect, it } from 'vitest'
import idlJson from '../../idl/horagon.json'
import {
  buildChallengeIx,
  buildCreateGameMarketIx,
  buildFinalizeIx,
  buildHaltIx,
  buildInitializeConfigIx,
  buildProposeResultIx,
  buildRecycleIx,
  buildUpdateConfigIx,
  buildWithdrawTreasuryIx,
  decodeConfig,
  decodeGameMarket,
  decodeHoragonEvent,
  HORAGON_ACCOUNT_DISCRIMINATORS,
  HORAGON_EVENT_DISCRIMINATORS,
  HORAGON_IX_DISCRIMINATORS,
  HORAGON_PROGRAM_ERRORS,
  HORAGON_PROGRAM_ID,
} from '../../src/program'
import { encodeIdl, type IdlType, type IdlTypeDef, key } from './idl-borsh'

type IdlSeed =
  | { kind: 'const'; value: number[] }
  | { kind: 'account'; path: string; account?: string }
  | { kind: 'arg'; path: string }
interface IdlPda {
  seeds: IdlSeed[]
  program?: { kind: 'const'; value: number[] } | { kind: 'account'; path: string }
}

interface IdlIx {
  name: string
  discriminator: number[]
  accounts: Array<{ name: string; writable?: boolean; signer?: boolean; pda?: IdlPda }>
  args: Array<{ name: string; type: IdlType }>
}
const idl = idlJson as unknown as {
  address: string
  instructions: IdlIx[]
  accounts: Array<{ name: string; discriminator: number[] }>
  events: Array<{ name: string; discriminator: number[] }>
  errors: Array<{ code: number; name: string }>
  types: IdlTypeDef[]
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
const ascii = (s: string, n: number) => Array.from({ length: n }, (_, i) => s.charCodeAt(i) || 0)
const hash = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const mint = key(2)

// One sample per instruction: the SDK call and the same arguments in IDL (snake_case) form.
const SAMPLES: Record<
  string,
  { build: () => TransactionInstruction; args: Record<string, unknown> }
> = {
  initialize_config: {
    build: () =>
      buildInitializeConfigIx({
        admin: key(1),
        attestor: key(3),
        guardians: [key(4), PublicKey.default],
        disputeWindowSecs: 900,
        collateralMint: mint,
      }),
    args: {
      args: {
        attestor: key(3),
        guardians: [key(4), PublicKey.default],
        dispute_window_secs: 900,
        collateral_mint: mint,
      },
    },
  },
  update_config: {
    build: () =>
      buildUpdateConfigIx({ admin: key(1), guardians: [key(5), key(6)], creationPaused: true }),
    args: {
      args: {
        attestor: null,
        guardians: [key(5), key(6)],
        dispute_window_secs: null,
        creation_paused: true,
      },
    },
  },
  create_game_market: {
    build: () =>
      buildCreateGameMarketIx({
        attestor: key(3),
        collateralMint: mint,
        marketId: 0x1122_3344_5566_7788n,
        kind: 1,
        league: 'NBA',
        externalGameId: '401910007',
        home: 'LAL',
        away: 'BOS',
        scheduledTipoff: 1_763_600_000,
        endTs: 1_763_607_800,
        name: 'HRG NBA BOS@LAL 1119 H2',
        initialPriceBps: 6_500,
        seedAmount: 1_000_000_000n,
      }),
    args: {
      args: {
        market_id: 0x1122_3344_5566_7788n,
        kind: 1,
        league: ascii('NBA', 8),
        external_game_id: '401910007',
        home: ascii('LAL', 4),
        away: ascii('BOS', 4),
        scheduled_tipoff: 1_763_600_000n,
        end_ts: 1_763_607_800n,
        name: 'HRG NBA BOS@LAL 1119 H2',
        initial_price_bps: 6_500,
        seed_amount: 1_000_000_000n,
      },
    },
  },
  halt: {
    build: () => buildHaltIx({ signer: key(3), marketId: 7n, collateralMint: mint }),
    args: {},
  },
  propose_result: {
    build: () =>
      buildProposeResultIx({
        signer: key(3),
        marketId: 7n,
        outcome: 'no',
        evidenceHash: hash,
        evidenceUri: 'https://horagon.com/api/v1/evidence/nba-401910007/winner',
      }),
    args: {
      args: {
        outcome: 'No',
        evidence_hash: [...hash],
        evidence_uri: 'https://horagon.com/api/v1/evidence/nba-401910007/winner',
      },
    },
  },
  challenge: { build: () => buildChallengeIx({ guardian: key(4), marketId: 7n }), args: {} },
  finalize: { build: () => buildFinalizeIx({ marketId: 7n }), args: {} },
  recycle: { build: () => buildRecycleIx({ marketId: 7n, collateralMint: mint }), args: {} },
  withdraw_treasury: {
    build: () =>
      buildWithdrawTreasuryIx({
        admin: key(1),
        collateralMint: mint,
        destination: key(9),
        amount: 5n,
      }),
    args: { amount: 5n },
  },
}

describe('horagon IDL contract', () => {
  it('uses the IDL address as the program id', () => {
    expect(HORAGON_PROGRAM_ID.toBase58()).toBe(idl.address)
  })

  it('has a sample for every instruction and nothing else', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(idl.instructions.map((i) => i.name).sort())
    expect(Object.keys(HORAGON_IX_DISCRIMINATORS).sort()).toEqual(
      idl.instructions.map((i) => camel(i.name)).sort(),
    )
  })

  for (const ixDef of idl.instructions) {
    it(`${ixDef.name}: discriminator, accounts and args match`, () => {
      const sample = SAMPLES[ixDef.name]
      if (!sample) throw new Error(`no sample for ${ixDef.name}`)
      const built = sample.build()
      expect(built.programId.equals(HORAGON_PROGRAM_ID)).toBe(true)
      expect([...built.data.subarray(0, 8)]).toEqual(ixDef.discriminator)
      expect(
        built.keys.map((k) => ({ signer: k.isSigner, writable: k.isWritable })),
        'account flags in IDL order',
      ).toEqual(ixDef.accounts.map((a) => ({ signer: !!a.signer, writable: !!a.writable })))
      const expected = Buffer.concat(
        ixDef.args.map((a) => encodeIdl(idl.types, a.type, sample.args[a.name])),
      )
      expect(Buffer.from(built.data.subarray(8)).toString('hex')).toBe(expected.toString('hex'))
    })
  }

  it('puts every PDA the IDL declares at its account index, derived from the IDL seeds', () => {
    // `game_market.market_id` reads a field of the on-chain GameMarket; the sample's market id.
    const marketIdOf = (name: string) =>
      name === 'create_game_market' ? 0x1122_3344_5566_7788n : 7n
    const u64 = (v: bigint) => {
      const b = Buffer.alloc(8)
      b.writeBigUInt64LE(v)
      return b
    }
    let checked = 0
    for (const ixDef of idl.instructions) {
      const sample = SAMPLES[ixDef.name]
      if (!sample) throw new Error(`no sample for ${ixDef.name}`)
      const built = sample.build()
      const addressOf = (path: string) => {
        const i = ixDef.accounts.findIndex((a) => a.name === path)
        const k = built.keys[i]
        if (!k) throw new Error(`${ixDef.name} has no account ${path}`)
        return k.pubkey
      }
      ixDef.accounts.forEach((acc, index) => {
        if (!acc.pda) return
        const seeds = acc.pda.seeds.map((seed): Uint8Array => {
          if (seed.kind === 'const') return Uint8Array.from(seed.value)
          if (seed.kind === 'arg') {
            const value = (sample.args.args as Record<string, unknown>)[
              seed.path.split('.')[1] ?? ''
            ]
            return u64(value as bigint)
          }
          if (seed.path.includes('.')) {
            expect(seed.path).toBe('game_market.market_id')
            return u64(marketIdOf(ixDef.name))
          }
          return addressOf(seed.path).toBytes()
        })
        const program = !acc.pda.program
          ? HORAGON_PROGRAM_ID
          : acc.pda.program.kind === 'const'
            ? new PublicKey(Uint8Array.from(acc.pda.program.value))
            : addressOf(acc.pda.program.path)
        const [expected] = PublicKey.findProgramAddressSync(seeds, program)
        expect(built.keys[index]?.pubkey.toBase58(), `${ixDef.name}.${acc.name}`).toBe(
          expected.toBase58(),
        )
        checked++
      })
    }
    expect(checked).toBeGreaterThanOrEqual(30)
  })

  it('decodes Config and GameMarket laid out as the IDL says', () => {
    for (const a of idl.accounts) {
      expect(HORAGON_ACCOUNT_DISCRIMINATORS[a.name as 'Config' | 'GameMarket']).toEqual(
        a.discriminator,
      )
    }
    const configBytes = Buffer.concat([
      Buffer.from(HORAGON_ACCOUNT_DISCRIMINATORS.Config),
      encodeIdl(
        idl.types,
        { defined: { name: 'Config' } },
        {
          admin: key(1),
          attestor: key(3),
          guardians: [key(4), key(5)],
          dispute_window_secs: 900,
          collateral_mint: mint,
          creation_paused: true,
          bump: 254,
        },
      ),
    ])
    const config = decodeConfig({ owner: HORAGON_PROGRAM_ID, data: configBytes })
    expect(config.guardians[1].equals(key(5))).toBe(true)
    expect(config).toMatchObject({ disputeWindowSecs: 900, creationPaused: true, bump: 254 })

    const gmBytes = Buffer.concat([
      Buffer.from(HORAGON_ACCOUNT_DISCRIMINATORS.GameMarket),
      encodeIdl(
        idl.types,
        { defined: { name: 'GameMarket' } },
        {
          market: key(8),
          market_id: 42n,
          kind: 0,
          league: ascii('NBA', 8),
          external_game_id: '401910007',
          home: ascii('NYK', 4),
          away: ascii('GSW', 4),
          scheduled_tipoff: 1_763_600_000n,
          end_ts: 1_763_607_800n,
          seed_amount: 300_000_000n,
          status: 'Proposed',
          proposed_outcome: 'Yes',
          evidence_hash: [...hash],
          evidence_uri: 'https://x.test/e',
          proposed_at: 1_763_607_900n,
          proposer: key(3),
          challenge_count: 2,
          finalized_at: 0n,
          bump: 253,
        },
      ),
    ])
    const gm = decodeGameMarket({ owner: HORAGON_PROGRAM_ID, data: gmBytes })
    expect(gm).toMatchObject({
      marketId: 42n,
      kind: 0,
      league: 'NBA',
      externalGameId: '401910007',
      home: 'NYK',
      away: 'GSW',
      endTs: 1_763_607_800,
      seedAmount: 300_000_000n,
      status: 'proposed',
      proposedOutcome: 'yes',
      evidenceUri: 'https://x.test/e',
      proposedAt: 1_763_607_900,
      challengeCount: 2,
      bump: 253,
    })
    expect(gm.proposer.equals(key(3))).toBe(true)
  })

  it('decodes every event laid out as the IDL says', () => {
    const samples: Record<string, Record<string, unknown>> = {
      GameMarketCreated: {
        game_market: key(1),
        market: key(2),
        market_id: 9n,
        kind: 1,
        end_ts: 100n,
        seed_amount: 300_000_000n,
        initial_price_bps: 5_000,
      },
      MarketHalted: { game_market: key(1), market: key(2), by: key(3), shares: 2n ** 70n + 5n },
      ResultProposed: {
        game_market: key(1),
        market: key(2),
        outcome: 'No',
        evidence_hash: [...hash],
        proposer: key(3),
        proposed_at: 200n,
      },
      ResultChallenged: { game_market: key(1), market: key(2), by: key(4), challenge_count: 1 },
      MarketFinalized: { game_market: key(1), market: key(2), outcome: 'Yes', finalized_at: 300n },
      MarketRecycled: { game_market: key(1), market: key(2), recovered: 123n },
    }
    expect(Object.keys(HORAGON_EVENT_DISCRIMINATORS).sort()).toEqual(
      idl.events.map((e) => e.name).sort(),
    )
    for (const e of idl.events) {
      const name = e.name as keyof typeof HORAGON_EVENT_DISCRIMINATORS
      expect(HORAGON_EVENT_DISCRIMINATORS[name]).toEqual(e.discriminator)
      const payload = Buffer.concat([
        Buffer.from(e.discriminator),
        encodeIdl(idl.types, { defined: { name } }, samples[name]),
      ])
      const decoded = decodeHoragonEvent(payload)
      expect(decoded?.name).toBe(name)
      expect(decoded && 'market' in decoded && decoded.market.equals(key(2))).toBe(true)
    }
    const halted = decodeHoragonEvent(
      Buffer.concat([
        Buffer.from(HORAGON_EVENT_DISCRIMINATORS.MarketHalted),
        encodeIdl(idl.types, { defined: { name: 'MarketHalted' } }, samples.MarketHalted),
      ]),
    )
    expect(halted).toMatchObject({ name: 'MarketHalted', shares: 2n ** 70n + 5n })
  })

  it('lists the program errors in IDL order from 6000', () => {
    expect(idl.errors.map((e) => e.name)).toEqual([...HORAGON_PROGRAM_ERRORS])
    expect(idl.errors.map((e) => e.code)).toEqual(HORAGON_PROGRAM_ERRORS.map((_, i) => 6000 + i))
  })
})
