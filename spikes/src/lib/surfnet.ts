import type { Connection } from '@solana/web3.js'
import { chainUnixTime } from './chain'
import { sleep } from './env'

/** Call a Surfpool cheatcode (`surfnet_*` JSON-RPC method). */
export async function surfnetCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
  return body.result
}

/**
 * Move the Surfnet clock forward to `unixSecs`. `absoluteTimestamp` is in milliseconds (a
 * seconds value is rejected as a past time). The cheatcode's parameters come from third-party
 * docs, so this verifies the Clock sysvar instead of trusting the call.
 */
export async function surfnetTimeTravel(
  rpcUrl: string,
  connection: Connection,
  unixSecs: number,
): Promise<void> {
  if ((await chainUnixTime(connection)) >= unixSecs) return
  await surfnetCall(rpcUrl, 'surfnet_timeTravel', [{ absoluteTimestamp: unixSecs * 1000 }])
  for (let i = 0; i < 40; i++) {
    if ((await chainUnixTime(connection)) >= unixSecs) return
    await sleep(250)
  }
  throw new Error(`surfnet_timeTravel did not move the clock to ${unixSecs}`)
}
