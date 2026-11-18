import { Connection } from '@solana/web3.js'

/** Genesis hash of Solana devnet. Spikes refuse every other cluster except a local one. */
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
export const DEVNET_RPC_URL = 'https://api.devnet.solana.com'
export const LOCAL_RPC_URL = 'http://127.0.0.1:8899'

export type Cluster = 'devnet' | 'local'

export function rpcUrl(cluster: Cluster): string {
  return cluster === 'devnet'
    ? (process.env.HORAGON_RPC_URL ?? DEVNET_RPC_URL)
    : (process.env.HORAGON_LOCAL_RPC_URL ?? LOCAL_RPC_URL)
}

/** A `confirmed` connection that is provably devnet, or a localhost RPC (Surfpool). */
export async function connect(cluster: Cluster): Promise<Connection> {
  const url = rpcUrl(cluster)
  const connection = new Connection(url, 'confirmed')
  if (cluster === 'devnet') {
    const genesis = await connection.getGenesisHash()
    if (genesis !== DEVNET_GENESIS_HASH) {
      throw new Error(`${url} is not devnet (genesis hash ${genesis})`)
    }
  } else if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) {
    throw new Error(`${url} is not a localhost RPC`)
  }
  return connection
}

/** `--cluster devnet|local` from argv, defaulting to `fallback`. */
export function clusterArg(fallback: Cluster): Cluster {
  const i = process.argv.indexOf('--cluster')
  const value = i >= 0 ? process.argv[i + 1] : fallback
  if (value !== 'devnet' && value !== 'local') throw new Error(`--cluster must be devnet or local`)
  return value
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
