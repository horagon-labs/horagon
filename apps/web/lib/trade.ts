// Build -> sign with the burner -> sponsored submit -> wait.
//
// A failed send is never repeated automatically: the sponsor may already hold the transaction,
// and it can still land. A new quote is built exactly once, and only when no earlier
// transaction can still land: the build failed with slippage (nothing was signed), the API's
// simulation refused the submit with slippage and no signature (nothing was broadcast), or the
// transaction landed and failed with slippage (6007). Everything else is thrown for the
// UI, which shows `failedSignature(err)` and the SDK's hint.
import {
  errorSignature,
  type HoragonClient,
  HoragonError,
  isHoragonError,
  type Quote,
  type TradeBuildRequest,
  type TxStatus,
} from '@horagon/sdk'
import { type Keypair, VersionedTransaction } from '@solana/web3.js'
import { Buffer } from 'buffer'

export type TradeStage = 'building' | 'signing' | 'submitting' | 'confirming' | 'requoting'
export type TradeClient = Pick<HoragonClient, 'trade' | 'claims'>

export interface TradeResult {
  signature: string
  status: TxStatus
  quote: Quote | undefined
  requoted: boolean
}

export const DEFAULT_SLIPPAGE_BPS = 200

const isSlippage = (err: unknown) => isHoragonError(err) && err.code === 'SLIPPAGE_EXCEEDED'

/** The transaction an error names (it may still land), or null. Read through the SDK only. */
export const failedSignature = (err: unknown): string | null => errorSignature(err) ?? null

/** Signs a server-built transaction as `signer` and returns it as base64. */
export function signBuilt(txBase64: string, signer: Keypair): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'))
  tx.sign([signer])
  return Buffer.from(tx.serialize()).toString('base64')
}

/** The same error, now naming `signature` the way the SDK's own client does. */
function namingSignature(err: HoragonError, signature: string): HoragonError {
  const named = new HoragonError(err.code, err.message, {
    hint: err.hint,
    cause: err,
    ...(err.programCode === undefined ? {} : { programCode: err.programCode }),
    ...(err.retryAfterSecs === undefined ? {} : { retryAfterSecs: err.retryAfterSecs }),
  })
  Object.defineProperty(named, 'signature', { value: signature, enumerable: true })
  return named
}

const unsureHint = (signature: string) =>
  `The transaction may still land. Check trade.status('${signature}'). Do not rebuild while it can land: build a new trade only if that signature is still unknown once its blockhash has expired (about 90 seconds).`

interface Sent {
  signature: string
  status: TxStatus
}

/**
 * Submits once and waits. A submit error is rethrown as it is. A wait that ends without a final
 * answer throws an error that names the signature. A final `failed` status is returned, not
 * thrown: the caller decides whether it is the one case that earns a new quote.
 */
async function submitAndWait(
  client: TradeClient,
  signed: string,
  onStage: (s: TradeStage) => void = () => {},
): Promise<Sent> {
  onStage('submitting')
  const signature = await client.trade.submit(signed)
  onStage('confirming')
  let status: TxStatus
  try {
    status = await client.trade.waitFor(signature, { timeoutMs: 60_000, pollMs: 1_000 })
  } catch (err) {
    if (isHoragonError(err)) {
      throw errorSignature(err) === undefined ? namingSignature(err, signature) : err
    }
    // Not an SDK error (a bug, an abort): still name the transaction, which may yet land.
    throw namingSignature(
      new HoragonError('NETWORK', err instanceof Error ? err.message : String(err), {
        cause: err,
        hint: unsureHint(signature),
      }),
      signature,
    )
  }
  if (
    status.status !== 'confirmed' &&
    status.status !== 'finalized' &&
    status.status !== 'failed'
  ) {
    throw namingSignature(
      new HoragonError('NETWORK', `${signature} is still ${status.status}`, {
        hint: unsureHint(signature),
      }),
      signature,
    )
  }
  return { signature, status }
}

/** The error for a transaction that landed and failed. */
function landedFailure({ signature, status }: Sent): HoragonError {
  const e = status.error
  return new HoragonError(e?.code ?? 'PROGRAM_ERROR', e?.message ?? `${signature} failed`, {
    ...(e?.programCode === undefined ? {} : { programCode: e.programCode }),
    ...(e?.hint === undefined ? {} : { hint: e.hint }),
  })
}

export async function executeTrade(
  client: TradeClient,
  signer: Keypair,
  req: TradeBuildRequest,
  onStage: (s: TradeStage) => void = () => {},
): Promise<TradeResult> {
  const request = { slippageBps: DEFAULT_SLIPPAGE_BPS, ...req }
  for (let attempt = 0; ; attempt++) {
    onStage('building')
    let built: Awaited<ReturnType<TradeClient['trade']['build']>>
    try {
      built = await client.trade.build(request)
    } catch (err) {
      // Nothing was signed or sent, so a fresh quote cannot double up.
      if (attempt === 0 && isSlippage(err)) {
        onStage('requoting')
        continue
      }
      throw err
    }
    onStage('signing')
    let sent: Sent
    try {
      sent = await submitAndWait(client, signBuilt(built.tx, signer), onStage)
    } catch (err) {
      // The API simulates before it sends. A slippage refusal with no signature means nothing
      // was broadcast, so a new quote cannot double up. Any other error is thrown as it is:
      // every later failure names the signature (or is not slippage).
      if (attempt === 0 && isSlippage(err) && errorSignature(err) === undefined) {
        onStage('requoting')
        continue
      }
      throw err
    }
    if (sent.status.status !== 'failed') {
      return { ...sent, quote: built.quote, requoted: attempt > 0 }
    }
    const failure = landedFailure(sent)
    // It landed and failed, so it cannot land again: one new quote is safe.
    if (attempt === 0 && isSlippage(failure)) {
      onStage('requoting')
      continue
    }
    throw failure
  }
}

/**
 * Claims every claimable market of `signer`; the API splits them into as few txs as fit. One
 * at a time, stopping at the first failure (rethrown under the rules above). `onClaimed` hears
 * each landed claim as it lands, so the UI still shows them when a later one fails. The UI
 * refreshes the claim list afterwards.
 */
export async function claimAll(
  client: TradeClient,
  signer: Keypair,
  onClaimed: (signature: string) => void = () => {},
): Promise<string[]> {
  const { txs } = await client.claims.build({ wallet: signer.publicKey.toBase58() })
  const signatures: string[] = []
  for (const built of txs) {
    const sent = await submitAndWait(client, signBuilt(built.tx, signer))
    if (sent.status.status === 'failed') throw landedFailure(sent)
    signatures.push(sent.signature)
    onClaimed(sent.signature)
  }
  return signatures
}
