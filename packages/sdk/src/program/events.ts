// Anchor events of the `horagon` program. `emit!` logs "Program data: <base64>" where the
// payload is sha256("event:<Name>")[0..8] followed by the Borsh fields. pm-AMM logs events
// the same way, so a line counts only while `horagon` is the innermost running program.
import type { PublicKey } from '@solana/web3.js'
import { Buffer } from 'buffer'
import type { Outcome } from '../schemas'
import { BorshReader } from './borsh'
import { HORAGON_PROGRAM_ID } from './constants'

export const HORAGON_EVENT_DISCRIMINATORS = {
  GameMarketCreated: [182, 38, 8, 139, 180, 210, 94, 15],
  MarketHalted: [229, 177, 26, 186, 171, 224, 162, 233],
  ResultProposed: [216, 229, 56, 182, 48, 192, 53, 251],
  ResultChallenged: [221, 74, 171, 75, 157, 103, 164, 252],
  MarketFinalized: [83, 62, 66, 204, 37, 76, 234, 179],
  MarketRecycled: [10, 191, 175, 83, 27, 245, 36, 110],
} as const

export type HoragonEvent =
  | {
      name: 'GameMarketCreated'
      gameMarket: PublicKey
      market: PublicKey
      marketId: bigint
      kind: 0 | 1
      endTs: number
      seedAmount: bigint
      initialPriceBps: number
    }
  | {
      name: 'MarketHalted'
      gameMarket: PublicKey
      market: PublicKey
      by: PublicKey
      shares: bigint
    }
  | {
      name: 'ResultProposed'
      gameMarket: PublicKey
      market: PublicKey
      outcome: Outcome
      evidenceHash: Uint8Array
      proposer: PublicKey
      proposedAt: number
    }
  | {
      name: 'ResultChallenged'
      gameMarket: PublicKey
      market: PublicKey
      by: PublicKey
      challengeCount: number
    }
  | {
      name: 'MarketFinalized'
      gameMarket: PublicKey
      market: PublicKey
      outcome: Outcome
      finalizedAt: number
    }
  | { name: 'MarketRecycled'; gameMarket: PublicKey; market: PublicKey; recovered: bigint }

const outcome = (r: BorshReader): Outcome => (r.u8() === 0 ? 'yes' : 'no')

const DECODERS: Record<
  keyof typeof HORAGON_EVENT_DISCRIMINATORS,
  (r: BorshReader) => HoragonEvent
> = {
  GameMarketCreated: (r) => ({
    name: 'GameMarketCreated',
    gameMarket: r.pubkey(),
    market: r.pubkey(),
    marketId: r.u64(),
    kind: r.u8() as 0 | 1,
    endTs: Number(r.i64()),
    seedAmount: r.u64(),
    initialPriceBps: r.u16(),
  }),
  MarketHalted: (r) => ({
    name: 'MarketHalted',
    gameMarket: r.pubkey(),
    market: r.pubkey(),
    by: r.pubkey(),
    shares: r.u128(),
  }),
  ResultProposed: (r) => ({
    name: 'ResultProposed',
    gameMarket: r.pubkey(),
    market: r.pubkey(),
    outcome: outcome(r),
    evidenceHash: r.fixed(32),
    proposer: r.pubkey(),
    proposedAt: Number(r.i64()),
  }),
  ResultChallenged: (r) => ({
    name: 'ResultChallenged',
    gameMarket: r.pubkey(),
    market: r.pubkey(),
    by: r.pubkey(),
    challengeCount: r.u8(),
  }),
  MarketFinalized: (r) => ({
    name: 'MarketFinalized',
    gameMarket: r.pubkey(),
    market: r.pubkey(),
    outcome: outcome(r),
    finalizedAt: Number(r.i64()),
  }),
  MarketRecycled: (r) => ({
    name: 'MarketRecycled',
    gameMarket: r.pubkey(),
    market: r.pubkey(),
    recovered: r.u64(),
  }),
}

const EVENT_ENTRIES = Object.entries(HORAGON_EVENT_DISCRIMINATORS) as Array<
  [keyof typeof HORAGON_EVENT_DISCRIMINATORS, readonly number[]]
>

/** Decodes one event payload (discriminator + fields), or undefined if it is not ours. */
export function decodeHoragonEvent(payload: Uint8Array): HoragonEvent | undefined {
  if (payload.length < 8) return undefined
  for (const [name, disc] of EVENT_ENTRIES) {
    if (disc.every((b, i) => payload[i] === b)) {
      const r = new BorshReader(payload)
      r.fixed(8)
      return DECODERS[name](r)
    }
  }
  return undefined
}

const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/
const EXIT = /^Program (\w+) (success|failed)/
const DATA = 'Program data: '

/**
 * Every `horagon` event in a transaction's log messages, in order. Tracks the invoke stack so
 * that pm-AMM's own "Program data:" lines (logged inside our CPIs) are skipped.
 */
export function parseHoragonEvents(
  logs: readonly string[],
  programId: PublicKey = HORAGON_PROGRAM_ID,
): HoragonEvent[] {
  const id = programId.toBase58()
  const stack: string[] = []
  const events: HoragonEvent[] = []
  for (const line of logs) {
    const invoke = INVOKE.exec(line)
    if (invoke?.[1]) {
      stack.push(invoke[1])
      continue
    }
    if (EXIT.test(line)) {
      stack.pop()
      continue
    }
    if (line.startsWith(DATA) && stack[stack.length - 1] === id) {
      const event = decodeHoragonEvent(Buffer.from(line.slice(DATA.length), 'base64'))
      if (event) events.push(event)
    }
  }
  return events
}
