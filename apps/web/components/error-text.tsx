import { isHoragonError } from '@horagon/sdk'
import { explorerTx, shortKey } from '../lib/format'
import { BUZZER_CLOSED } from '../lib/trade-form'
import { failedSignature } from '../lib/trade-shared'

/**
 * How the words are shown: `countdown`, a live countdown of a RATE_LIMITED wait is on screen;
 * `gameFinal`, the game is over, so a halted market is the close at the final buzzer (R5c).
 */
export interface ErrorTextOptions {
  countdown?: boolean
  gameFinal?: boolean
}

/**
 * The API's message and its "what to do now" hint; never a stack or an RPC URL. With a live
 * countdown beside it (the crown's HoldButton), a RATE_LIMITED wait leaves the seconds to it.
 * Once the game is final, MARKET_HALTED is the normal close: it says so, never "halted".
 */
export function errorText(err: unknown, opts: ErrorTextOptions = {}): string {
  if (isHoragonError(err)) {
    if (err.code === 'RATE_LIMITED' && err.retryAfterSecs !== undefined) {
      if (opts.countdown) return 'Too many requests.'
      return `Too many requests. Try again in ${Math.ceil(err.retryAfterSecs)} s.`
    }
    if (err.code === 'MARKET_HALTED' && opts.gameFinal) return BUZZER_CLOSED
    return err.hint ? `${err.message} ${err.hint}` : err.message
  }
  return 'Something went wrong. Try again.'
}

/**
 * An error, and when it names a transaction (`failedSignature`, read through the SDK only),
 * that transaction: it may still land, so nothing here offers to send again (R2).
 */
export function ErrorText({ error, countdown, gameFinal }: { error: unknown } & ErrorTextOptions) {
  if (error === undefined || error === null) return null
  const signature = failedSignature(error)
  return (
    // A signature is one 88-character token: let it break anywhere so a phone never scrolls.
    <div role="alert" className="space-y-1 text-13 text-red-400 [overflow-wrap:anywhere]">
      <p>{errorText(error, { countdown, gameFinal })}</p>
      {signature && (
        <p>
          This transaction may still land:{' '}
          <a
            href={explorerTx(signature)}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline"
          >
            {shortKey(signature)}
          </a>
          . Check its status on the explorer first, then build a new trade only after its blockhash
          expires (about 90 seconds).
        </p>
      )}
    </div>
  )
}
