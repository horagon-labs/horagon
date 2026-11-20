import {
  atasClosedAway,
  type DbHandle,
  recordSponsoredAtas,
  sponsoredAtasToCheck,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import { createCloseAccountInstruction, createTransferCheckedInstruction } from '@solana/spl-token'
import {
  Keypair,
  type PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type VersionedTransactionResponse,
} from '@solana/web3.js'
import pino, { type Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Alerter } from '../src/alerts'
import { type AtaWatchDeps, closeDestination, watchSponsoredAtas } from '../src/ata-watch'

const sponsor = Keypair.generate().publicKey
const mint = Keypair.generate().publicKey
const key = () => Keypair.generate().publicKey

/** A confirmed transaction holding `ixs`, as getTransaction returns it. */
function confirmed(payer: PublicKey, ixs: TransactionInstruction[]) {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
    instructions: ixs,
  }).compileToV0Message()
  return {
    slot: 1,
    blockTime: 1,
    transaction: new VersionedTransaction(message),
    meta: { err: null },
  } as unknown as VersionedTransactionResponse
}

describe('closeDestination', () => {
  it('finds where a CloseAccount of this ATA sent the rent', () => {
    const owner = key()
    const ata = key()
    const to = key()
    const tx = confirmed(owner, [
      createTransferCheckedInstruction(ata, mint, key(), owner, 1n, 6),
      createCloseAccountInstruction(ata, to, owner),
    ])
    expect(closeDestination(tx, ata.toBase58())).toBe(to.toBase58())
    expect(closeDestination(tx, key().toBase58())).toBeUndefined()
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
    log: { warn: (obj: Record<string, unknown>) => warns.push(obj) } as unknown as Logger,
    now: () => NOW_SECS,
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
      getSignaturesForAddress: async () =>
        [
          { signature: 'failed', err: { InstructionError: [0, 'x'] } },
          { signature: 'gone', err: null },
        ] as never,
      getTransaction: async () => null,
    })
    expect(await watchSponsoredAtas(deps)).toEqual({ checked: 1, closed: 1, flagged: 1 })
    expect(await atasClosedAway(h.db, row?.wallet ?? '', sponsor.toBase58())).toBe(1)
  })
})
