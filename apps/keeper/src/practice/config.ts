// The Practice process's settings (R8), read beside the keeper's own (`loadConfig`, which this
// file reuses and never changes): the same .env.keeper, plus PRACTICE_SOURCE_URL and
// PRACTICE_SOL_FLOOR. Without PRACTICE_SOURCE_URL or HORAGON_PUBLIC_URL the process refuses to
// start: a Practice result must link its recording and its evidence.
import { personAlertWindow } from '../alerts'
import { type Cluster, type KeeperConfig, loadConfig } from '../config'
import { evidenceUri, publicBaseUrl } from '../propose'
import { practiceSourceUrl } from './runs'

/** Below this much SOL on the attestor, no Practice run starts: NBA nights keep their SOL. */
export const DEFAULT_PRACTICE_SOL_FLOOR = 1

export interface PracticeSettings {
  /** PRACTICE_SOURCE_URL: the public tests/fixtures/replay folder, no trailing slash. */
  sourceBase: string
  /** HORAGON_PUBLIC_URL, checked: the evidence link's base. */
  publicUrl: string
  solFloorLamports: bigint
}

export interface PracticeConfig extends PracticeSettings {
  keeper: KeeperConfig
}

/** The Practice variables alone, checked; throws with the variable's name. */
export function practiceSettings(env: NodeJS.ProcessEnv, cluster: Cluster): PracticeSettings {
  const sourceBase = practiceSourceUrl(env.PRACTICE_SOURCE_URL)
  if (!env.HORAGON_PUBLIC_URL)
    throw new Error('HORAGON_PUBLIC_URL is not set: a Practice result links its evidence')
  const publicUrl = publicBaseUrl(env.HORAGON_PUBLIC_URL, cluster)
  // The longest Practice game id must fit the on-chain URI.
  evidenceUri(publicUrl, cluster, `practice-${'0'.repeat(16)}`)
  const raw = env.PRACTICE_SOL_FLOOR
  const floor = raw === undefined || raw === '' ? DEFAULT_PRACTICE_SOL_FLOOR : Number(raw)
  if (!Number.isFinite(floor) || floor < 0 || floor > 1_000)
    throw new Error('PRACTICE_SOL_FLOOR must be a number of SOL from 0 to 1000')
  return { sourceBase, publicUrl, solFloorLamports: BigInt(Math.round(floor * 1e9)) }
}

/** The keeper's configuration and the Practice settings; the Practice ones are checked first. */
export function loadPracticeConfig(env: NodeJS.ProcessEnv = process.env): PracticeConfig {
  const cluster: Cluster = env.HORAGON_CLUSTER === 'localnet' ? 'localnet' : 'devnet'
  const settings = practiceSettings(env, cluster)
  return { ...settings, keeper: loadConfig(env) }
}

/** The SOL floor pages once a day; every other key keeps the keeper's windows. */
export function practiceAlertWindow(key: string): number | undefined {
  if (key === 'practice-sol-floor') return 86_400
  return personAlertWindow(key)
}
