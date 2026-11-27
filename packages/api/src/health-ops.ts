// The ops numbers of GET /health (R9): the sponsor's SOL, the treasury's mUSDC, the resolution
// backlog and the index lag. They never change `ok`: a number that cannot be read is null with a
// reason. The chain and backlog reads are kept OPS_TTL_SECS per process, one read at a time, so
// a burst of health checks makes one RPC call (both accounts in one getMultipleAccountsInfo) and
// one query; the index lag comes from the keeper heartbeat the health check reads anyway.
import { unresolvedBacklog } from '@horagon/db'
import { errorSummary } from '@horagon/sdk'
import type { PublicKey } from '@solana/web3.js'
import type { ApiDeps } from './deps'

export const OPS_TTL_SECS = 45

export interface HealthOps {
  asOf: number
  sponsor: { lamports: number | null; reason?: string }
  treasury: { musdc: number | null; reason?: string }
  backlog: { count: number | null; oldestAgeSecs: number | null; reason?: string }
  index: { lagSecs: number | null; reason?: string }
}

type Cached = Omit<HealthOps, 'index'>

/** SPL token account: the u64 amount at byte 64 (Token and Token-2022 alike). */
function tokenAmount(data: Uint8Array): bigint | null {
  if (data.length < 72) return null
  return new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true)
}

async function chainNumbers(deps: ApiDeps): Promise<Pick<Cached, 'sponsor' | 'treasury'>> {
  const sponsor: PublicKey | undefined = deps.sponsor?.keypair.publicKey
  const keys = sponsor ? [deps.program.treasury, sponsor] : [deps.program.treasury]
  let infos: Awaited<ReturnType<ApiDeps['connection']['getMultipleAccountsInfo']>>
  try {
    infos = await deps.connection.getMultipleAccountsInfo(keys, 'confirmed')
  } catch (e) {
    deps.log.warn({ error: errorSummary(e) }, 'health ops: accounts unread')
    const reason = 'rpc unavailable'
    return {
      sponsor: { lamports: null, reason: sponsor ? reason : 'sponsor not configured' },
      treasury: { musdc: null, reason },
    }
  }
  const [treasuryInfo, sponsorInfo] = infos
  // An account that does not exist holds nothing.
  const amount = treasuryInfo ? tokenAmount(treasuryInfo.data) : 0n
  return {
    sponsor: sponsor
      ? { lamports: sponsorInfo?.lamports ?? 0 }
      : { lamports: null, reason: 'sponsor not configured' },
    treasury:
      amount === null
        ? { musdc: null, reason: 'treasury is not a token account' }
        : { musdc: Number(amount) / 1e6 },
  }
}

async function backlogNumbers(deps: ApiDeps, now: number): Promise<Cached['backlog']> {
  try {
    const b = await unresolvedBacklog(deps.db, new Date(now * 1000))
    return {
      count: b.count,
      oldestAgeSecs:
        b.oldestEndTs === null
          ? null
          : Math.max(0, now - Math.floor(b.oldestEndTs.getTime() / 1000)),
    }
  } catch (e) {
    deps.log.warn({ error: errorSummary(e) }, 'health ops: backlog unread')
    return { count: null, oldestAgeSecs: null, reason: 'db unavailable' }
  }
}

/** Seconds since the keeper's index loop last ended a round (`index.lastRoundAt`). */
export function indexLag(
  heartbeat: { info: Record<string, unknown> } | null,
  now: number,
): HealthOps['index'] {
  if (!heartbeat) return { lagSecs: null, reason: 'no keeper heartbeat' }
  const index = heartbeat.info.index as { lastRoundAt?: unknown } | undefined
  const at = index?.lastRoundAt
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return { lagSecs: null, reason: 'no index round time in the keeper heartbeat' }
  }
  return { lagSecs: Math.max(0, now - at) }
}

/** One per app: the cached part of the ops numbers, read again once older than OPS_TTL_SECS. */
export function healthOpsReader(deps: ApiDeps) {
  let cached: { at: number; value: Promise<Cached> } | null = null
  return async (
    heartbeat: Promise<{ info: Record<string, unknown> } | null>,
  ): Promise<HealthOps> => {
    const now = deps.now()
    if (!cached || now - cached.at > OPS_TTL_SECS) {
      const at = now
      const value = Promise.all([chainNumbers(deps), backlogNumbers(deps, at)]).then(
        ([chain, backlog]): Cached => ({ asOf: at, ...chain, backlog }),
      )
      cached = { at, value }
    }
    // The chain and backlog reads run beside the health checks' own reads, not after them.
    const [c, hb] = await Promise.all([cached.value, heartbeat])
    return { ...c, index: indexLag(hb, now) }
  }
}
