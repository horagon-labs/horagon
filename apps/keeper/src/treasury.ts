// Treasury upkeep (spec 6.3): claim the pm-AMM faucet into the keeper wallet every hour, move
// mUSDC into the treasury (the Authority's ATA) up to next night's seeds + 20%, and alert when
// the treasury or the SOL that pays for markets runs low.
import { type Db, listGames, logOps } from '@horagon/db'
import { errorSummary, type HoragonProgram } from '@horagon/sdk'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import type { Keypair } from '@solana/web3.js'
import type { Logger } from 'pino'
import type { Alerter } from './alerts'
import type { TxSender } from './executor'
import { easternDate } from './feeds/types'
import type { SeedPolicy } from './planner'

/**
 * Spec 6.3, spikes S1 and S2: 0.03538 SOL of rent per market, paid by the Authority PDA, rounded
 * up. claim_winnings later closes the Authority's YES/NO ATAs and returns about 0.003 SOL of it.
 */
export const LAMPORTS_PER_MARKET = 36_000_000n
/** Fees for one night of creates, halts, finalizes and recycles, with margin. */
export const KEEPER_MIN_LAMPORTS = 200_000_000n

/** Next night's seeds + 20%, rounded up to whole mUSDC. */
export function topUpTarget(seeds: readonly bigint[]): bigint {
  const total = seeds.reduce((a, b) => a + b, 0n)
  const target = (total * 12n + 9n) / 10n
  return ((target + 999_999n) / 1_000_000n) * 1_000_000n
}

/** How much to move from the keeper wallet: what is missing, capped by what it holds. */
export function transferAmount(treasury: bigint, keeper: bigint, target: bigint): bigint {
  if (treasury >= target) return 0n
  const missing = target - treasury
  return missing < keeper ? missing : keeper
}

export interface TreasuryDeps {
  db: Db
  sender: TxSender
  program: HoragonProgram
  attestor: Keypair
  alerts: Alerter
  log: Logger
  seeds: SeedPolicy
  now: () => number
  /** Claims 1,000 mUSDC into `wallet`; throws when rate limited. */
  faucet: (wallet: string) => Promise<unknown>
  priorityMicroLamports: number
}

/**
 * NBA games starting in the next 36 h that have no market yet, earliest first. A Practice run
 * checks its own seed before it starts (R8).
 */
async function upcomingGames(deps: Pick<TreasuryDeps, 'db' | 'now'>) {
  const now = deps.now()
  const games = await listGames(deps.db, {
    from: new Date(now * 1000),
    to: new Date((now + 36 * 3600) * 1000),
    statuses: ['scheduled'],
    leagues: ['NBA'],
  })
  return games.filter((g) => g.markets.length === 0)
}

/** Seeds of the games starting in the next 36 h that have no market yet. */
export async function upcomingSeeds(
  deps: Pick<TreasuryDeps, 'db' | 'seeds' | 'now'>,
): Promise<bigint[]> {
  return (await upcomingGames(deps)).map((g) =>
    g.featured ? deps.seeds.featured : deps.seeds.regular,
  )
}

/** A token account that does not exist holds nothing; any other RPC failure is not an answer. */
export const isMissingAccount = (err: unknown) =>
  /could not find account|account does not exist|\baccount [1-9A-HJ-NP-Za-km-z]{32,44} not found/i.test(
    errorSummary(err).message,
  )

export async function treasuryTick(deps: TreasuryDeps): Promise<{ moved: bigint; target: bigint }> {
  const conn = deps.sender.connection
  const keeper = deps.attestor.publicKey
  const mint = deps.program.collateralMint
  try {
    await deps.faucet(keeper.toBase58())
  } catch (err) {
    deps.log.info({ error: errorSummary(err).message }, 'faucet skipped')
  }
  const games = await upcomingGames(deps)
  const seeds = games.map((g) => (g.featured ? deps.seeds.featured : deps.seeds.regular))
  const target = topUpTarget(seeds)

  // The SOL checks come first: a keeper out of SOL is the likeliest reason a send fails. The two
  // reads are independent: a failed one warns and skips only its own alert.
  const [authorityRead, keeperRead] = await Promise.allSettled([
    conn.getBalance(deps.program.authority, 'confirmed'),
    conn.getBalance(keeper, 'confirmed'),
  ])
  try {
    if (authorityRead.status === 'rejected') throw authorityRead.reason
    const authoritySol = BigInt(authorityRead.value)
    // Spec 6.3: alert when the Authority's SOL covers fewer than 2 nights of markets. A night is
    // the next game date (US Eastern), not the whole 36 h window.
    const nextDate = games[0] ? easternDate(games[0].scheduledTipoff) : undefined
    const tonight = games.filter((g) => easternDate(g.scheduledTipoff) === nextDate).length
    const perNight = BigInt(Math.max(tonight, 4))
    if (authoritySol < 2n * perNight * LAMPORTS_PER_MARKET) {
      await deps.alerts.send(
        'sol-authority',
        `Authority holds ${Number(authoritySol) / 1e9} SOL, under 2 nights of markets: horagon-ops fund-authority`,
      )
    }
  } catch (err) {
    deps.log.warn({ error: errorSummary(err).message }, 'SOL balance check skipped: authority')
  }
  try {
    if (keeperRead.status === 'rejected') throw keeperRead.reason
    const keeperSol = BigInt(keeperRead.value)
    if (keeperSol < KEEPER_MIN_LAMPORTS) {
      await deps.alerts.send(
        'sol-keeper',
        `Keeper wallet holds ${Number(keeperSol) / 1e9} SOL; fees need ${Number(KEEPER_MIN_LAMPORTS) / 1e9}`,
      )
    }
  } catch (err) {
    deps.log.warn({ error: errorSummary(err).message }, 'SOL balance check skipped: keeper')
  }

  const keeperAta = getAssociatedTokenAddressSync(mint, keeper)
  const balance = (ata: typeof keeperAta) =>
    conn.getTokenAccountBalance(ata, 'confirmed').then(
      (r) => BigInt(r.value.amount),
      (err: unknown) => {
        if (isMissingAccount(err)) return 0n
        throw err
      },
    )
  let treasury: bigint
  let held: bigint
  try {
    ;[treasury, held] = await Promise.all([balance(deps.program.treasury), balance(keeperAta)])
  } catch (err) {
    // Unknown balances: moving mUSDC or paging about them would act on a guess.
    deps.log.warn({ error: errorSummary(err).message }, 'treasury top-up skipped: balance unread')
    return { moved: 0n, target }
  }
  let moved = transferAmount(treasury, held, target)
  if (moved > 0n) {
    let sig: string | null = null
    try {
      const res = await deps.sender.send({
        label: 'treasury top-up',
        instructions: [
          createAssociatedTokenAccountIdempotentInstruction(
            keeper,
            deps.program.treasury,
            deps.program.authority,
            mint,
          ),
          createTransferCheckedInstruction(
            keeperAta,
            mint,
            deps.program.treasury,
            keeper,
            moved,
            6,
          ),
        ],
        computeUnits: 60_000,
        priorityMicroLamports: deps.priorityMicroLamports,
        // An unreadable balance means "not done"; the sender then checks its own signatures.
        isDone: async () => {
          try {
            return (await balance(deps.program.treasury)) >= treasury + moved
          } catch {
            return false
          }
        },
      })
      sig = res.signature
    } catch (err) {
      deps.log.warn({ error: errorSummary(err).message }, 'treasury top-up failed')
      moved = 0n
    }
    if (moved > 0n) {
      // The transfer landed; a failed log write must not turn it into a failed top-up.
      try {
        await logOps(deps.db, {
          actor: 'keeper',
          action: 'top-up',
          sig,
          detail: { amount: moved.toString() },
        })
      } catch (err) {
        deps.log.warn({ error: errorSummary(err).message }, 'treasury top-up not logged')
      }
    }
  }
  if (treasury + moved < target) {
    await deps.alerts.send(
      'treasury-low',
      `Treasury ${(treasury + moved) / 1_000_000n} mUSDC, next 36 h needs ${target / 1_000_000n}`,
    )
  }
  return { moved, target }
}
