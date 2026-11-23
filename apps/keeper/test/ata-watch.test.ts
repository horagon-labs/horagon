import {
  atasClosedAway,
  type DbHandle,
  recordSponsoredAtas,
  schema,
  sponsoredAtasToCheck,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import {
  ataAddress,
  buildClaimWinningsIx,
  buildRedeemPairIx,
  deriveNoMint,
  deriveYesMint,
} from '@horagon/sdk'
import {
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  Keypair,
  type PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type VersionedTransactionResponse,
} from '@solana/web3.js'
import pino, { type Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Alerter } from '../src/alerts'
import { type AtaWatchDeps, closeOf, watchSponsoredAtas } from '../src/ata-watch'

const sponsor = Keypair.generate().publicKey
const mint = Keypair.generate().publicKey
const key = () => Keypair.generate().publicKey
/** SPL Token CloseAccount data ([9]) in base58, as a transaction response gives inner data. */
const CLOSE_DATA_B58 = 'A'

type Inner = NonNullable<NonNullable<VersionedTransactionResponse['meta']>['innerInstructions']>

/** A confirmed transaction holding `ixs`, as getTransaction returns it. */
function confirmed(payer: PublicKey, ixs: TransactionInstruction[], inner?: Inner) {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
    instructions: ixs,
  }).compileToV0Message()
  return {
    slot: 1,
    blockTime: 1,
    transaction: new VersionedTransaction(message),
    meta: { err: null, ...(inner ? { innerInstructions: inner } : {}) },
  } as unknown as VersionedTransactionResponse
}

/**
 * A sponsored transaction whose top-level instruction `parent` (on `market`, signed by `user`)
 * closed the user's YES and NO accounts through Token CPIs, rent to the user: what pm-AMM's
 * claim_winnings does ("Settled: ... accounts closed").
 */
function closedInside(
  parent: (p: {
    user: PublicKey
    market: PublicKey
    collateralMint: PublicKey
  }) => TransactionInstruction,
  user: PublicKey,
  market = key(),
) {
  const outcome = [deriveYesMint(market), deriveNoMint(market)].map((m) =>
    ataAddress({ owner: user, mint: m }),
  ) as [PublicKey, PublicKey]
  const ix = parent({ user, market, collateralMint: mint })
  const keys = new TransactionMessage({
    payerKey: sponsor,
    recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
    instructions: [ix],
  }).compileToV0Message().staticAccountKeys
  const at = (k: PublicKey) => keys.findIndex((x) => x.equals(k))
  const instructions = outcome.map((a) => ({
    programIdIndex: at(TOKEN_PROGRAM_ID),
    accounts: [at(a), at(user), at(user)],
    data: CLOSE_DATA_B58,
  }))
  return { tx: confirmed(sponsor, [ix], [{ index: 0, instructions }]), outcome }
}

/**
 * A transaction of `ixs` where the inner group at each `index` closes `ata` (rent to `to`,
 * authority `owner`) through a Token CPI.
 */
function withCloses(
  ixs: TransactionInstruction[],
  closes: Array<{ index: number; ata: PublicKey; to: PublicKey; owner: PublicKey }>,
) {
  // The close instructions only register their keys: they are cut from the top level below.
  const message = new TransactionMessage({
    payerKey: sponsor,
    recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
    instructions: [
      ...ixs,
      ...closes.map((c) => createCloseAccountInstruction(c.ata, c.to, c.owner)),
    ],
  }).compileToV0Message()
  message.compiledInstructions = message.compiledInstructions.slice(0, ixs.length)
  const at = (k: PublicKey) => message.staticAccountKeys.findIndex((x) => x.equals(k))
  const inner = closes.map((c) => ({
    index: c.index,
    instructions: [
      {
        programIdIndex: at(TOKEN_PROGRAM_ID),
        accounts: [at(c.ata), at(c.to), at(c.owner)],
        data: CLOSE_DATA_B58,
      },
    ],
  }))
  return {
    slot: 1,
    blockTime: 1,
    transaction: new VersionedTransaction(message),
    meta: { err: null, innerInstructions: inner },
  } as unknown as VersionedTransactionResponse
}

describe('closeOf', () => {
  it('finds where a CloseAccount of this ATA sent the rent', () => {
    const owner = key()
    const ata = key()
    const to = key()
    const tx = confirmed(owner, [
      createTransferCheckedInstruction(ata, mint, key(), owner, 1n, 6),
      createCloseAccountInstruction(ata, to, owner),
    ])
    expect(closeOf(tx, ata.toBase58())).toEqual({ to: to.toBase58(), byClaim: false })
    expect(closeOf(tx, key().toBase58())).toBeUndefined()
  })

  it('finds the closes claim_winnings makes inside itself, and marks them as a claim', () => {
    const user = key()
    const { tx, outcome } = closedInside(buildClaimWinningsIx, user)
    for (const ata of outcome) {
      expect(closeOf(tx, ata.toBase58())).toEqual({ to: user.toBase58(), byClaim: true })
    }
    expect(closeOf(tx, ataAddress({ owner: user, mint }).toBase58())).toBeUndefined()
  })

  it('maps an inner close to its own parent: a claim next to another program is not the claim', () => {
    const user = key()
    const market = key()
    const yes = ataAddress({ owner: user, mint: deriveYesMint(market) })
    const other = SystemProgram.transfer({ fromPubkey: user, toPubkey: key(), lamports: 1 })
    const claim = buildClaimWinningsIx({ user, market, collateralMint: mint })
    // The close sits in the inner group of instruction 1 (the other program), not the claim's.
    const tx = withCloses([claim, other], [{ index: 1, ata: yes, to: user, owner: user }])
    expect(closeOf(tx, yes.toBase58())).toEqual({ to: user.toBase58(), byClaim: false })
    // The same close under instruction 0 is the claim's.
    const own = withCloses([claim, other], [{ index: 0, ata: yes, to: user, owner: user }])
    expect(closeOf(own, yes.toBase58())).toEqual({ to: user.toBase58(), byClaim: true })
  })

  it('gives each claim of a two-market transaction its own closes', () => {
    const user = key()
    const [a, b] = [key(), key()]
    const ataA = ataAddress({ owner: user, mint: deriveYesMint(a) })
    const ataB = ataAddress({ owner: user, mint: deriveNoMint(b) })
    const claims = [a, b].map((market) =>
      buildClaimWinningsIx({ user, market, collateralMint: mint }),
    )
    const tx = withCloses(claims, [
      { index: 0, ata: ataA, to: user, owner: user },
      { index: 1, ata: ataB, to: user, owner: user },
    ])
    for (const ata of [ataA, ataB]) {
      expect(closeOf(tx, ata.toBase58())).toEqual({ to: user.toBase58(), byClaim: true })
    }
    // Each close is only a claim close under its own parent: swapped, both are flagged.
    const swapped = withCloses(claims, [
      { index: 1, ata: ataA, to: user, owner: user },
      { index: 0, ata: ataB, to: user, owner: user },
    ])
    for (const ata of [ataA, ataB]) {
      expect(closeOf(swapped, ata.toBase58())).toEqual({ to: user.toBase58(), byClaim: false })
    }
  })

  it('flags a claim on one market that appears to close an ATA of another market', () => {
    const user = key()
    const [a, b] = [key(), key()]
    const claimA = buildClaimWinningsIx({ user, market: a, collateralMint: mint })
    for (const mintOf of [deriveYesMint, deriveNoMint]) {
      const ataB = ataAddress({ owner: user, mint: mintOf(b) })
      const tx = withCloses([claimA], [{ index: 0, ata: ataB, to: user, owner: user }])
      expect(closeOf(tx, ataB.toBase58())).toEqual({ to: user.toBase58(), byClaim: false })
    }
    // Nor does it close another owner's account of market A.
    const stranger = ataAddress({ owner: key(), mint: deriveYesMint(a) })
    const tx = withCloses([claimA], [{ index: 0, ata: stranger, to: user, owner: user }])
    expect(closeOf(tx, stranger.toBase58())).toEqual({ to: user.toBase58(), byClaim: false })
  })

  it('does not take a close inside any other instruction for a claim', () => {
    const user = key()
    const { tx, outcome } = closedInside((p) => buildRedeemPairIx({ ...p, amount: 1n }), user)
    expect(closeOf(tx, outcome[0].toBase58())).toEqual({ to: user.toBase58(), byClaim: false })
  })
})

describe('watchSponsoredAtas', () => {
  let h: DbHandle
  beforeEach(async () => {
    h = await createTestDb()
  })
  afterEach(async () => {
    await h.close()
  })

  it('records closes, alerts the ones whose rent left the sponsor, and blocks those wallets', async () => {
    const wallets = { open: key(), home: key(), away: key(), lost: key() }
    const atas = { open: key(), home: key(), away: key(), lost: key() }
    const createdAt = new Date('2026-11-24T01:00:00Z')
    await recordSponsoredAtas(
      h.db,
      (Object.keys(atas) as Array<keyof typeof atas>).map((k) => ({
        ata: atas[k].toBase58(),
        wallet: wallets[k].toBase58(),
        mint: mint.toBase58(),
        createdSig: `create-${k}`,
        createdAt,
      })),
    )
    // `home` closed its ATA back to the sponsor, `away` to itself; `lost` has no close we can see.
    const closes = new Map<string, VersionedTransactionResponse>([
      [
        atas.home.toBase58(),
        confirmed(wallets.home, [createCloseAccountInstruction(atas.home, sponsor, wallets.home)]),
      ],
      [
        atas.away.toBase58(),
        confirmed(wallets.away, [
          createCloseAccountInstruction(atas.away, wallets.away, wallets.away),
        ]),
      ],
    ])
    const connection = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) =>
        keys.map((k) => (k.equals(atas.open) ? {} : null)),
      getSignaturesForAddress: async (k: PublicKey) =>
        closes.has(k.toBase58()) ? [{ signature: `close:${k.toBase58()}`, err: null }] : [],
      getTransaction: async (sig: string) => closes.get(sig.slice('close:'.length)) ?? null,
    } as unknown as AtaWatchDeps['connection']
    const sent: Array<[string, string]> = []
    const alerts: Alerter = {
      send: async (k, text) => {
        sent.push([k, text])
      },
    }
    const deps: AtaWatchDeps = {
      db: h.db,
      connection,
      sponsor,
      alerts,
      log: pino({ level: 'silent' }),
      now: () => Date.parse('2026-11-24T02:00:00Z') / 1000,
    }

    expect(await watchSponsoredAtas(deps)).toEqual({ checked: 4, closed: 3, flagged: 2 })
    expect(sent.map(([k]) => k).sort()).toEqual(
      [`ata-close:${wallets.away.toBase58()}`, `ata-close:${wallets.lost.toBase58()}`].sort(),
    )
    expect(sent.find(([k]) => k.endsWith(wallets.away.toBase58()))?.[1]).toContain(
      `rent to ${wallets.away.toBase58()}`,
    )
    const away = (w: PublicKey) => atasClosedAway(h.db, w.toBase58(), sponsor.toBase58())
    expect(await away(wallets.home)).toBe(0)
    expect(await away(wallets.away)).toBe(1)
    // A close we cannot trace counts against the wallet: the sponsor errs on keeping its SOL.
    expect(await away(wallets.lost)).toBe(1)
    expect(await away(wallets.open)).toBe(0)

    // Closed ATAs are done; the open one is checked again on the next pass.
    expect(await watchSponsoredAtas(deps)).toEqual({ checked: 1, closed: 0, flagged: 0 })
  })

  // Task 24 e2e: claim_winnings closes YES and NO itself and pays their rent to the user. That
  // is how every claim on a resolved market ends, not a rent grab: no alert, no block.
  it('expects the closes of a claim: no alert, and the wallet keeps its sponsored accounts', async () => {
    const wallet = key()
    const { tx: claim, outcome } = closedInside(buildClaimWinningsIx, wallet)
    await recordSponsoredAtas(
      h.db,
      outcome.map((ata, i) => ({
        ata: ata.toBase58(),
        wallet: wallet.toBase58(),
        mint: mint.toBase58(),
        createdSig: `create-${i}`,
        createdAt: new Date('2026-11-24T01:00:00Z'),
      })),
    )
    const connection = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => null),
      // Newest first: the claim, then the trade that created the account.
      getSignaturesForAddress: async () => [
        { signature: 'claim-sig', err: null },
        { signature: 'trade-sig', err: null },
      ],
      getTransaction: async (sig: string) =>
        sig === 'claim-sig'
          ? claim
          : confirmed(sponsor, [
              createTransferCheckedInstruction(key(), mint, key(), wallet, 1n, 6),
            ]),
    } as unknown as AtaWatchDeps['connection']
    const sent: string[] = []
    const deps: AtaWatchDeps = {
      db: h.db,
      connection,
      sponsor,
      alerts: {
        send: async (k) => {
          sent.push(k)
        },
      },
      log: pino({ level: 'silent' }),
      now: () => Date.parse('2026-11-24T02:00:00Z') / 1000,
    }
    expect(await watchSponsoredAtas(deps)).toEqual({ checked: 2, closed: 2, flagged: 0 })
    expect(sent).toEqual([])
    expect(await atasClosedAway(h.db, wallet.toBase58(), sponsor.toBase58())).toBe(0)
    const rows = await h.db.select().from(schema.sponsoredAtas)
    expect(rows.map((r) => r.closedSig)).toEqual(['claim-sig', 'claim-sig'])
    // The marker says what it was; the rent went to the user, not the sponsor.
    expect(rows.map((r) => r.closedTo)).toEqual(['claim', 'claim'])
    expect(await sponsoredAtasToCheck(h.db)).toEqual([])
  })

  it('does not let a close found for an old creation land on a newer one recorded meanwhile', async () => {
    const wallet = key()
    const ata = key()
    const rec = (sig: string, min: number) => ({
      ata: ata.toBase58(),
      wallet: wallet.toBase58(),
      mint: mint.toBase58(),
      createdSig: sig,
      createdAt: new Date(Date.UTC(2026, 10, 24, 1, min)),
    })
    await recordSponsoredAtas(h.db, [rec('c1', 0)])
    const close = confirmed(wallet, [createCloseAccountInstruction(ata, wallet, wallet)])
    const connection = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => null),
      // While the close is being traced, the same address is created again.
      getSignaturesForAddress: async () => {
        await recordSponsoredAtas(h.db, [rec('c2', 30)])
        return [{ signature: 'close-sig', err: null }]
      },
      getTransaction: async () => close,
    } as unknown as AtaWatchDeps['connection']
    const deps: AtaWatchDeps = {
      db: h.db,
      connection,
      sponsor,
      alerts: { send: async () => {} },
      log: pino({ level: 'silent' }),
      now: () => Date.parse('2026-11-24T02:00:00Z') / 1000,
    }
    await watchSponsoredAtas(deps)
    // The new creation is still open and watched.
    const open = await sponsoredAtasToCheck(h.db)
    expect(open.map((r) => r.createdSig)).toEqual(['c2'])
    expect(open[0]?.closedAt).toBeNull()
  })

  const NOW_SECS = Date.parse('2026-11-24T02:00:00Z') / 1000
  const record = async (n: number, createdAt = new Date('2026-11-24T01:00:00Z')) => {
    const rows = Array.from({ length: n }, (_, i) => ({
      ata: key().toBase58(),
      wallet: key().toBase58(),
      mint: mint.toBase58(),
      createdSig: `c${i}`,
      createdAt,
    }))
    await recordSponsoredAtas(h.db, rows)
    return rows
  }
  const depsWith = (
    connection: Record<string, unknown>,
    extra: Partial<AtaWatchDeps> = {},
    sent: string[] = [],
    warns: Array<Record<string, unknown>> = [],
  ): AtaWatchDeps => ({
    db: h.db,
    connection: {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => null),
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null,
      ...connection,
    } as unknown as AtaWatchDeps['connection'],
    sponsor,
    alerts: {
      send: async (k) => {
        sent.push(k)
      },
    },
    log: {
      warn: (obj: Record<string, unknown>) => warns.push(obj),
      info: () => {},
    } as unknown as Logger,
    now: () => NOW_SECS,
    traces: new Map(),
    ...extra,
  })

  it('does not close an ATA younger than 10 minutes on one empty read', async () => {
    const young = new Date((NOW_SECS - 60) * 1000)
    const [row] = await record(1, young)
    const calls: string[] = []
    const deps = depsWith({
      getSignaturesForAddress: async (k: PublicKey) => {
        calls.push(k.toBase58())
        return []
      },
    })
    expect(await watchSponsoredAtas(deps)).toEqual({ checked: 1, closed: 0, flagged: 0 })
    expect(calls).toEqual([])
    const open = await sponsoredAtasToCheck(h.db)
    expect(open.map((r) => r.ata)).toEqual([row?.ata])
    expect(open[0]?.checkedAt).toEqual(new Date(NOW_SECS * 1000))
    // Once it is old enough, the same empty read closes it.
    const later = depsWith({}, { now: () => NOW_SECS + 600 })
    expect(await watchSponsoredAtas(later)).toEqual({ checked: 1, closed: 1, flagged: 1 })
  })

  it('clamps the batch to 1..100 ATAs per pass', async () => {
    await record(101)
    const sizes: number[] = []
    const connection = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        sizes.push(keys.length)
        return keys.map(() => ({}))
      },
    }
    await watchSponsoredAtas(depsWith(connection, { batch: 1000 }))
    await watchSponsoredAtas(depsWith(connection, { batch: 0 }))
    expect(sizes).toEqual([100, 1])
  })

  it('leaves a row whose lookup fails for the next pass and carries on with the others', async () => {
    const rows = await record(2)
    const [bad, good] = rows as [(typeof rows)[number], (typeof rows)[number]]
    const warns: Array<Record<string, unknown>> = []
    const deps = depsWith(
      {
        getSignaturesForAddress: async (k: PublicKey) => {
          if (k.toBase58() === bad.ata) throw new Error('rpc down')
          return []
        },
      },
      {},
      [],
      warns,
    )
    expect(await watchSponsoredAtas(deps)).toEqual({ checked: 2, closed: 1, flagged: 1 })
    expect(warns).toHaveLength(2)
    expect(JSON.stringify(warns[0])).not.toContain('stack')
    const open = await sponsoredAtasToCheck(h.db)
    expect(open.map((r) => r.ata)).toEqual([bad.ata])
    expect(open[0]?.checkedAt).toEqual(new Date(NOW_SECS * 1000))
    expect(await atasClosedAway(h.db, good.wallet, sponsor.toBase58())).toBe(1)
  })

  it('records unknown when the signatures failed or their transactions are gone', async () => {
    const [row] = await record(1)
    const deps = depsWith({
      getSignaturesForAddress: async (_k: PublicKey, o: { before?: string }) =>
        o.before
          ? []
          : ([
              { signature: 'failed', err: { InstructionError: [0, 'x'] } },
              { signature: 'gone', err: null },
            ] as never),
      getTransaction: async () => null,
    })
    expect(await watchSponsoredAtas(deps)).toEqual({ checked: 1, closed: 1, flagged: 1 })
    expect(await atasClosedAway(h.db, row?.wallet ?? '', sponsor.toBase58())).toBe(1)
  })

  /** A connection whose address history is `sigs` (newest first), paged like the RPC. */
  const history = (sigs: string[], tx: (sig: string) => VersionedTransactionResponse | null) => {
    const calls: Array<{ limit?: number; before?: string; until?: string }> = []
    return {
      calls,
      connection: {
        getSignaturesForAddress: async (
          _k: PublicKey,
          o: { limit?: number; before?: string; until?: string },
        ) => {
          calls.push(o)
          const from = o.before ? sigs.indexOf(o.before) + 1 : 0
          const until = o.until ? sigs.indexOf(o.until) : -1
          return sigs
            .slice(from, until < 0 ? sigs.length : until)
            .slice(0, o.limit ?? 1000)
            .map((signature) => ({ signature, err: null }))
        },
        getTransaction: async (sig: string) => tx(sig),
      },
    }
  }
  const transfer = () =>
    confirmed(sponsor, [createTransferCheckedInstruction(key(), mint, key(), key(), 1n, 6)])

  it('finds a claim pushed past the first 10 signatures by cheap transactions naming the address', async () => {
    const wallet = key()
    const { tx: claim, outcome } = closedInside(buildClaimWinningsIx, wallet)
    await recordSponsoredAtas(h.db, [
      {
        ata: (outcome[0] as PublicKey).toBase58(),
        wallet: wallet.toBase58(),
        mint: mint.toBase58(),
        createdSig: 'create-sig',
        createdAt: new Date('2026-11-24T01:00:00Z'),
      },
    ])
    const noise = Array.from({ length: 25 }, (_, i) => `noise-${i}`)
    const h2 = history([...noise, 'claim-sig', 'create-sig'], (sig) =>
      sig === 'claim-sig' ? claim : transfer(),
    )
    const sent: string[] = []
    expect(await watchSponsoredAtas(depsWith(h2.connection, {}, sent))).toEqual({
      checked: 1,
      closed: 1,
      flagged: 0,
    })
    expect(sent).toEqual([])
    expect(await atasClosedAway(h.db, wallet.toBase58(), sponsor.toBase58())).toBe(0)
    const [saved] = await h.db.select().from(schema.sponsoredAtas)
    expect([saved?.closedSig, saved?.closedTo]).toEqual(['claim-sig', 'claim'])
    // Asked to stop at the creation signature.
    expect(h2.calls.every((c) => c.until === 'create-sig')).toBe(true)
  })

  it('stops reading at the creation signature', async () => {
    await record(1)
    const read: string[] = []
    const h2 = history(['a', 'b', 'c0', 'older'], (sig) => {
      read.push(sig)
      return null
    })
    // Even when the RPC ignores `until`, nothing at or before the creation is read.
    const ignoring = {
      ...h2.connection,
      getSignaturesForAddress: async (k: PublicKey, o: object) =>
        h2.connection.getSignaturesForAddress(k, { ...o, until: undefined }),
    }
    await watchSponsoredAtas(depsWith(ignoring))
    expect(read).toEqual(['a', 'b'])
  })

  /** A row whose address history is `noise` cheap transactions, then the claim, then the creation. */
  const flooded = async (noise: number) => {
    const wallet = key()
    const { tx: claim, outcome } = closedInside(buildClaimWinningsIx, wallet)
    const ata = outcome[0] as PublicKey
    await recordSponsoredAtas(h.db, [
      {
        ata: ata.toBase58(),
        wallet: wallet.toBase58(),
        mint: mint.toBase58(),
        createdSig: 'create-sig',
        createdAt: new Date('2026-11-24T01:00:00Z'),
      },
    ])
    const sigs = [
      ...Array.from({ length: noise }, (_, i) => `noise-${i}`),
      'claim-sig',
      'create-sig',
    ]
    let txCalls = 0
    const h2 = history(sigs, (sig) => {
      txCalls++
      return sig === 'claim-sig' ? claim : transfer()
    })
    return { wallet, ata, h2, txCalls: () => txCalls }
  }

  it('resolves a flood larger than one pass budget to the real claim over several passes, with no flag in between', async () => {
    const f = await flooded(450)
    const sent: string[] = []
    const deps = depsWith(f.h2.connection, { budget: { txCalls: 200, ms: 60_000 } }, sent)
    const claimed = async () => atasClosedAway(h.db, f.wallet.toBase58(), sponsor.toBase58())
    expect(await watchSponsoredAtas(deps)).toEqual({ checked: 1, closed: 0, flagged: 0 })
    expect(f.txCalls()).toBe(200)
    expect(await watchSponsoredAtas(deps)).toEqual({ checked: 1, closed: 0, flagged: 0 })
    expect(f.txCalls()).toBe(400)
    expect(sent).toEqual([])
    expect(await claimed()).toBe(0)
    // Each pass resumes after the oldest signature already read.
    expect(f.h2.calls.map((c) => c.before)).toEqual([undefined, 'noise-199'])
    // Third pass: 50 noise and the claim.
    expect(await watchSponsoredAtas(deps)).toEqual({ checked: 1, closed: 1, flagged: 0 })
    expect(f.h2.calls.map((c) => c.before)).toEqual([undefined, 'noise-199', 'noise-399'])
    expect(sent).toEqual([])
    expect(await claimed()).toBe(0)
    const [saved] = await h.db.select().from(schema.sponsoredAtas)
    expect([saved?.closedSig, saved?.closedTo]).toEqual(['claim-sig', 'claim'])
  })

  it('stops a pass at 200 getTransaction calls by default, leaving every row open and unflagged', async () => {
    const f = await flooded(500)
    await record(2)
    const sent: string[] = []
    const out = await watchSponsoredAtas(depsWith(f.h2.connection, {}, sent))
    expect(out).toEqual({ checked: 3, closed: 0, flagged: 0 })
    expect(f.txCalls()).toBe(200)
    expect(sent).toEqual([])
    expect(await sponsoredAtasToCheck(h.db)).toHaveLength(3)
  })

  it('stops a pass after 20 s of wall time, checked before each RPC call', async () => {
    const f = await flooded(100)
    let t = 0
    const deps = depsWith(
      {
        ...f.h2.connection,
        getTransaction: async (sig: string) => {
          t += 5_000
          return f.h2.connection.getTransaction(sig)
        },
      },
      { clock: () => t },
    )
    expect(await watchSponsoredAtas(deps)).toEqual({ checked: 1, closed: 0, flagged: 0 })
    expect(f.txCalls()).toBe(4)
  })

  it('flags unknown only when the walk reaches the creation without finding a close', async () => {
    const [row] = await record(1)
    const h2 = history(['a', 'b', 'c0'], () => transfer())
    const sent: string[] = []
    expect(await watchSponsoredAtas(depsWith(h2.connection, {}, sent))).toEqual({
      checked: 1,
      closed: 1,
      flagged: 1,
    })
    expect(sent).toEqual([`ata-close:${row?.wallet}`])
  })

  it('raises one ata-trace alert after 6 consecutive cut-off passes, and not a flag', async () => {
    const f = await flooded(80)
    const sent: string[] = []
    const warns: Array<Record<string, unknown>> = []
    const deps = depsWith(f.h2.connection, { budget: { txCalls: 5, ms: 60_000 } }, sent, warns)
    for (let i = 1; i <= 5; i++) await watchSponsoredAtas(deps)
    expect(sent).toEqual([])
    await watchSponsoredAtas(deps)
    expect(sent).toEqual([`ata-trace:${f.ata.toBase58()}`])
    expect(warns.filter((w) => w.ata === f.ata.toBase58() && w.passes === 6)).toHaveLength(1)
    await watchSponsoredAtas(deps)
    await watchSponsoredAtas(deps)
    expect(sent).toHaveLength(1)
    expect(await atasClosedAway(h.db, f.wallet.toBase58(), sponsor.toBase58())).toBe(0)
  })
})
