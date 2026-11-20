import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  Keypair,
  type PublicKey,
  type VersionedTransaction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { DEVNET_MUSDC_MINT, PM_AMM_PROGRAM_ID, PROTOCOL_DAO } from '../../src/pm-amm/constants'
import { deriveNoMint, deriveYesMint } from '../../src/pm-amm/pda'
import { buildClaimTransactions } from '../../src/tx/claim'
import {
  ataAddress,
  buildTradeTransaction,
  MAX_TX_BYTES,
  SWAP_COMPUTE_UNITS,
  tradeAtas,
} from '../../src/tx/trade'

const BLOCKHASH = '11111111111111111111111111111111'
const sponsor = Keypair.generate().publicKey
const user = Keypair.generate().publicKey
const authority = Keypair.generate().publicKey
const market = Keypair.generate().publicKey

function programs(tx: VersionedTransaction): string[] {
  const keys = tx.message.staticAccountKeys
  return tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]?.toBase58() ?? '?')
}

describe('buildTradeTransaction', () => {
  const swap = {
    user,
    market,
    collateralMint: DEVNET_MUSDC_MINT,
    authority,
    direction: 'usdcToYes' as const,
    amountIn: 50_000_000n,
    minOut: 1n,
  }

  it('lists the five ATAs spec section 9 sponsors', () => {
    const owners = tradeAtas(swap).map((a) => a.owner.toBase58())
    expect(owners).toEqual([user, user, user, PROTOCOL_DAO, authority].map((k) => k.toBase58()))
  })

  it('puts the sponsor first, then the user, and fits with every ATA missing', () => {
    const tx = buildTradeTransaction({
      feePayer: sponsor,
      recentBlockhash: BLOCKHASH,
      swap,
      createAtas: tradeAtas(swap),
    })
    expect(tx.message.staticAccountKeys[0]?.equals(sponsor)).toBe(true)
    expect(tx.message.staticAccountKeys[1]?.equals(user)).toBe(true)
    expect(tx.message.header.numRequiredSignatures).toBe(2)
    expect(tx.serialize().length).toBeLessThanOrEqual(MAX_TX_BYTES)
    const p = programs(tx)
    expect(p[0]).toBe(ComputeBudgetProgram.programId.toBase58())
    expect(p.at(-1)).toBe(PM_AMM_PROGRAM_ID.toBase58())
    expect(p.length).toBe(1 + 5 + 1)
    const limit = tx.message.compiledInstructions[0]?.data
    expect(limit && Buffer.from(limit).readUInt32LE(1)).toBe(SWAP_COMPUTE_UNITS)
  })

  it('skips ATA creates the caller says exist, and adds a price only when asked', () => {
    const tx = buildTradeTransaction({
      feePayer: sponsor,
      recentBlockhash: BLOCKHASH,
      swap,
      createAtas: [],
      microLamportsPerCu: 5_000,
    })
    expect(programs(tx)).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      PM_AMM_PROGRAM_ID.toBase58(),
    ])
  })
})

describe('buildClaimTransactions', () => {
  const markets = Array.from({ length: 10 }, () => ({
    market: Keypair.generate().publicKey,
    collateralMint: DEVNET_MUSDC_MINT,
  }))

  function claimedMarkets(tx: VersionedTransaction): string[] {
    const keys = tx.message.staticAccountKeys
    return tx.message.compiledInstructions
      .filter((ix) => keys[ix.programIdIndex]?.equals(PM_AMM_PROGRAM_ID))
      .map((ix) => keys[ix.accountKeyIndexes[1] ?? -1]?.toBase58() ?? '?')
  }

  it('splits ten claims into transactions that each fit, covering every market once', () => {
    const txs = buildClaimTransactions({
      user,
      feePayer: sponsor,
      recentBlockhash: BLOCKHASH,
      markets,
      closeAccounts: true,
      rentDestination: sponsor,
    })
    expect(txs.length).toBeGreaterThan(1)
    for (const tx of txs) expect(tx.serialize().length).toBeLessThanOrEqual(MAX_TX_BYTES)
    expect(txs.flatMap(claimedMarkets)).toEqual(markets.map((m) => m.market.toBase58()))
  })

  it('closes YES and NO to the rent destination, owner = user', () => {
    const [tx] = buildClaimTransactions({
      user,
      feePayer: sponsor,
      recentBlockhash: BLOCKHASH,
      markets: markets.slice(0, 1),
      closeAccounts: true,
      rentDestination: sponsor,
    })
    if (!tx) throw new Error('no transaction')
    const keys = tx.message.staticAccountKeys
    const closes = tx.message.compiledInstructions.filter((ix) =>
      keys[ix.programIdIndex]?.equals(TOKEN_PROGRAM_ID),
    )
    expect(closes).toHaveLength(2)
    const yesAta = ataAddress({ owner: user, mint: deriveYesMint(markets[0]?.market as PublicKey) })
    const first = closes[0]?.accountKeyIndexes.map((i) => keys[i]?.toBase58())
    expect(first).toEqual([yesAta.toBase58(), sponsor.toBase58(), user.toBase58()])
  })

  it('splits correctly when the collateral ATA must be created first', () => {
    const txs = buildClaimTransactions({
      user,
      feePayer: sponsor,
      recentBlockhash: BLOCKHASH,
      markets,
      closeAccounts: true,
      rentDestination: sponsor,
      createCollateralAta: { owner: user, mint: DEVNET_MUSDC_MINT },
    })
    expect(txs.length).toBeGreaterThan(1)
    for (const tx of txs) expect(tx.serialize().length).toBeLessThanOrEqual(MAX_TX_BYTES)
    expect(txs.flatMap(claimedMarkets)).toEqual(markets.map((m) => m.market.toBase58()))
  })

  it('splits correctly when some markets need their YES or NO ATA created', () => {
    const withAtas = markets.map((m, i) =>
      i === 0
        ? { ...m, createAtas: [{ owner: user, mint: deriveNoMint(m.market) }] }
        : i === 5
          ? { ...m, createAtas: [{ owner: user, mint: deriveYesMint(m.market) }] }
          : m,
    )
    const txs = buildClaimTransactions({
      user,
      feePayer: sponsor,
      recentBlockhash: BLOCKHASH,
      markets: withAtas,
      closeAccounts: true,
      rentDestination: sponsor,
    })
    for (const tx of txs) expect(tx.serialize().length).toBeLessThanOrEqual(MAX_TX_BYTES)
    expect(txs.flatMap(claimedMarkets)).toEqual(markets.map((m) => m.market.toBase58()))
  })

  it('refuses to close sponsor-paid accounts to anyone but the sponsor', () => {
    expect(() =>
      buildClaimTransactions({
        user,
        feePayer: sponsor,
        recentBlockhash: BLOCKHASH,
        markets: markets.slice(0, 1),
        closeAccounts: true,
        rentDestination: user,
      }),
    ).toThrow(/rent/)
  })

  it('lets the user close their own accounts to themselves when they pay', () => {
    const txs = buildClaimTransactions({
      user,
      feePayer: user,
      recentBlockhash: BLOCKHASH,
      markets: markets.slice(0, 1),
      closeAccounts: true,
      rentDestination: user,
    })
    expect(txs).toHaveLength(1)
  })

  it('returns no transaction for no market', () => {
    expect(
      buildClaimTransactions({
        user,
        feePayer: sponsor,
        recentBlockhash: BLOCKHASH,
        markets: [],
        closeAccounts: true,
        rentDestination: sponsor,
      }),
    ).toEqual([])
  })
})
