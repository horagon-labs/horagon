import { type AccountInfo, type Connection, PublicKey, SystemProgram } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { describe, expect, it } from 'vitest'
import idlJson from '../../idl/horagon.json'
import { HoragonError } from '../../src/errors'
import { DEVNET_MUSDC_MINT, PM_AMM_PROGRAM_ID } from '../../src/pm-amm'
import {
  authorityOutcomeAtaIxs,
  buildChallengeIx,
  buildCreateGameMarketIx,
  buildFinalizeIx,
  buildHaltIx,
  buildInitializeConfigIx,
  buildProposeResultIx,
  buildRecycleIx,
  buildUpdateConfigIx,
  buildWithdrawTreasuryIx,
  HORAGON_ACCOUNT_DISCRIMINATORS,
  HORAGON_PROGRAM_ID,
  HoragonProgram,
  horagonInstructionName,
} from '../../src/program'
import type { IdlTypeDef } from './idl-borsh'
import { encodeIdl, key } from './idl-borsh'

const types = (idlJson as unknown as { types: IdlTypeDef[] }).types
const mint = DEVNET_MUSDC_MINT
const hp = new HoragonProgram({ collateralMint: mint })

const info = (owner: PublicKey, data: Uint8Array): AccountInfo<Buffer> => ({
  owner,
  data: Buffer.from(data),
  lamports: 1,
  executable: false,
  rentEpoch: 0,
})

const configData = Buffer.concat([
  Buffer.from(HORAGON_ACCOUNT_DISCRIMINATORS.Config),
  encodeIdl(
    types,
    { defined: { name: 'Config' } },
    {
      admin: key(1),
      attestor: key(3),
      guardians: [key(4), key(5)],
      dispute_window_secs: 900,
      collateral_mint: mint,
      creation_paused: false,
      bump: 255,
    },
  ),
])

const gameMarketData = (marketId: bigint) =>
  Buffer.concat([
    Buffer.from(HORAGON_ACCOUNT_DISCRIMINATORS.GameMarket),
    encodeIdl(
      types,
      { defined: { name: 'GameMarket' } },
      {
        market: key(8),
        market_id: marketId,
        kind: 0,
        league: [78, 66, 65, 0, 0, 0, 0, 0],
        external_game_id: '401910007',
        home: [76, 65, 76, 0],
        away: [66, 79, 83, 0],
        scheduled_tipoff: 1n,
        end_ts: 2n,
        seed_amount: 3n,
        status: 'Open',
        proposed_outcome: null,
        evidence_hash: new Array(32).fill(0),
        evidence_uri: '',
        proposed_at: 0n,
        proposer: PublicKey.default,
        challenge_count: 0,
        finalized_at: 0n,
        bump: 254,
      },
    ),
  ])

function stub(opts: {
  account?: AccountInfo<Buffer> | null
  rows?: Array<{ pubkey: PublicKey; account: AccountInfo<Buffer> }>
}) {
  const calls: unknown[][] = []
  const connection = {
    getAccountInfo: async (...args: unknown[]) => {
      calls.push(args)
      return opts.account ?? null
    },
    getProgramAccounts: async (...args: unknown[]) => {
      calls.push(args)
      return opts.rows ?? []
    },
  } as unknown as Connection
  return { connection, calls }
}

describe('HoragonProgram.fetchConfig', () => {
  it('returns null when the account is missing', async () => {
    expect(await hp.fetchConfig(stub({ account: null }).connection)).toBeNull()
  })

  it('returns null for a System-owned, empty (pre-funded) address', async () => {
    const { connection } = stub({ account: info(SystemProgram.programId, new Uint8Array(0)) })
    expect(await hp.fetchConfig(connection)).toBeNull()
  })

  it('throws for an account owned by another program', async () => {
    const { connection } = stub({ account: info(PM_AMM_PROGRAM_ID, configData) })
    await expect(hp.fetchConfig(connection)).rejects.toThrow(/not owned/)
  })

  it('throws for a System-owned account that holds data', async () => {
    const { connection } = stub({ account: info(SystemProgram.programId, configData) })
    await expect(hp.fetchConfig(connection)).rejects.toThrow(/not owned/)
  })

  it('throws on a wrong discriminator', async () => {
    const { connection } = stub({ account: info(HORAGON_PROGRAM_ID, new Uint8Array(200)) })
    await expect(hp.fetchConfig(connection)).rejects.toThrow(/not a Config/)
  })

  it('decodes the account at the config PDA', async () => {
    const { connection, calls } = stub({ account: info(HORAGON_PROGRAM_ID, configData) })
    const config = await hp.fetchConfig(connection)
    expect(config).toMatchObject({ disputeWindowSecs: 900, creationPaused: false, bump: 255 })
    expect((calls[0] as PublicKey[])[0]?.toBase58()).toBe(hp.config.toBase58())
  })
})

describe('HoragonProgram.fetchGameMarket', () => {
  it('returns null when missing or when the address only holds lamports', async () => {
    expect(await hp.fetchGameMarket(stub({ account: null }).connection, 5n)).toBeNull()
    const funded = stub({ account: info(SystemProgram.programId, new Uint8Array(0)) })
    expect(await hp.fetchGameMarket(funded.connection, 5n)).toBeNull()
  })

  it('throws for any other owner and for a bad discriminator', async () => {
    const wrongOwner = stub({ account: info(PM_AMM_PROGRAM_ID, gameMarketData(5n)) })
    await expect(hp.fetchGameMarket(wrongOwner.connection, 5n)).rejects.toThrow(/not owned/)
    const wrongDisc = stub({ account: info(HORAGON_PROGRAM_ID, new Uint8Array(400)) })
    await expect(hp.fetchGameMarket(wrongDisc.connection, 5n)).rejects.toThrow(/not a GameMarket/)
  })

  it('decodes the account at the game_market PDA', async () => {
    const { connection, calls } = stub({ account: info(HORAGON_PROGRAM_ID, gameMarketData(5n)) })
    const gm = await hp.fetchGameMarket(connection, 5n)
    expect(gm).toMatchObject({ marketId: 5n, league: 'NBA', status: 'open', home: 'LAL' })
    expect((calls[0] as PublicKey[])[0]?.toBase58()).toBe(hp.addresses(5n).gameMarket.toBase58())
  })
})

describe('HoragonProgram.listGameMarkets', () => {
  it('filters on the GameMarket discriminator and decodes every row', async () => {
    const rows = [
      { pubkey: key(1), account: info(HORAGON_PROGRAM_ID, gameMarketData(1n)) },
      { pubkey: key(2), account: info(HORAGON_PROGRAM_ID, gameMarketData(2n)) },
    ]
    const { connection, calls } = stub({ rows })
    const list = await hp.listGameMarkets(connection)
    expect(list.map((r) => r.account.marketId)).toEqual([1n, 2n])
    expect(list[1]?.pubkey.equals(key(2))).toBe(true)
    const [programId, config] = calls[0] as [PublicKey, { filters: Array<{ memcmp: unknown }> }]
    expect(programId.equals(HORAGON_PROGRAM_ID)).toBe(true)
    expect(config.filters).toEqual([
      {
        memcmp: {
          offset: 0,
          bytes: Buffer.from(HORAGON_ACCOUNT_DISCRIMINATORS.GameMarket).toString('base64'),
          encoding: 'base64',
        },
      },
    ])
  })

  it('returns an empty list', async () => {
    expect(await hp.listGameMarkets(stub({ rows: [] }).connection)).toEqual([])
  })

  it('wraps a row that cannot be decoded in PROGRAM_ERROR with the cause', async () => {
    const rows = [{ pubkey: key(1), account: info(HORAGON_PROGRAM_ID, new Uint8Array(400)) }]
    const err = await hp.listGameMarkets(stub({ rows }).connection).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HoragonError)
    expect((err as HoragonError).code).toBe('PROGRAM_ERROR')
    expect((err as HoragonError).cause).toBeInstanceOf(HoragonError)
  })
})

describe('HoragonProgram.ix wrappers', () => {
  const same = (a: { keys: unknown; data: Uint8Array; programId: PublicKey }, b: typeof a) => {
    expect(a.programId.equals(b.programId)).toBe(true)
    expect(a.keys).toEqual(b.keys)
    expect(Buffer.from(a.data).toString('hex')).toBe(Buffer.from(b.data).toString('hex'))
  }
  const hash = new Uint8Array(32).fill(7)

  it('initializeConfig and updateConfig', () => {
    const init = {
      admin: key(1),
      attestor: key(3),
      guardians: [key(4), key(5)] as [PublicKey, PublicKey],
      disputeWindowSecs: 900,
    }
    same(hp.ix.initializeConfig(init), buildInitializeConfigIx({ ...init, collateralMint: mint }))
    same(
      hp.ix.updateConfig({ admin: key(1), creationPaused: true }),
      buildUpdateConfigIx({ admin: key(1), creationPaused: true }),
    )
  })

  it('createGameMarket', () => {
    const p = {
      attestor: key(3),
      marketId: 9n,
      kind: 1 as const,
      league: 'NBA',
      externalGameId: '401910007',
      home: 'LAL',
      away: 'BOS',
      scheduledTipoff: 1,
      endTs: 2,
      name: 'HRG NBA BOS@LAL 1119 H2',
      initialPriceBps: 5_000,
      seedAmount: 1n,
    }
    same(hp.ix.createGameMarket(p), buildCreateGameMarketIx({ ...p, collateralMint: mint }))
  })

  it('proposeResult, challenge, finalize and withdrawTreasury', () => {
    const propose = {
      signer: key(3),
      marketId: 7n,
      outcome: 'yes' as const,
      evidenceHash: hash,
      evidenceUri: 'https://x.test/e',
    }
    same(hp.ix.proposeResult(propose), buildProposeResultIx(propose))
    same(
      hp.ix.challenge({ guardian: key(4), marketId: 7n }),
      buildChallengeIx({ guardian: key(4), marketId: 7n }),
    )
    same(hp.ix.finalize({ marketId: 7n }), buildFinalizeIx({ marketId: 7n }))
    const w = { admin: key(1), destination: key(9), amount: 5n }
    same(hp.ix.withdrawTreasury(w), buildWithdrawTreasuryIx({ ...w, collateralMint: mint }))
  })

  it('halt and recycle are [YES ATA, NO ATA, instruction]', () => {
    const halt = hp.ix.halt({ signer: key(3), marketId: 7n }, key(2))
    expect(halt).toHaveLength(3)
    const atas = authorityOutcomeAtaIxs(key(2), { marketId: 7n })
    expect(halt.slice(0, 2).map((i) => i.keys)).toEqual(atas.map((i) => i.keys))
    same(
      halt[2] as (typeof halt)[number],
      buildHaltIx({ signer: key(3), marketId: 7n, collateralMint: mint }),
    )

    const recycle = hp.ix.recycle({ marketId: 7n }, key(2))
    expect(recycle).toHaveLength(3)
    expect(recycle[2] && horagonInstructionName(recycle[2].data)).toBe('recycle')
    same(
      recycle[2] as (typeof recycle)[number],
      buildRecycleIx({ marketId: 7n, collateralMint: mint }),
    )
  })

  it('uses a custom program id throughout', () => {
    const other = key(42)
    const custom = new HoragonProgram({ collateralMint: mint, programId: other })
    expect(custom.ix.finalize({ marketId: 1n }).programId.equals(other)).toBe(true)
    expect(custom.authority.equals(hp.authority)).toBe(false)
  })
})
