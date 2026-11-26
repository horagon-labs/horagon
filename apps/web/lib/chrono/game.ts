// The game screen's dial (spec 4.2, 4.3): the state table, the needle (a proposal turns it
// toward the proposed side), and the time ring from the market's real start_ts once the market
// state has loaded; tip-off - 60 min stands in until then, as on the board.
import { effectiveTime, type Game, type MarketSummary, type Outcome } from '@horagon/sdk'
import { timeLeftFraction } from './geometry'
import {
  type DialState,
  deriveDialState,
  dialLabel,
  isTrading,
  needlePrice,
  secsToClose,
} from './state'
import { PRE_OPEN_SECS } from './tracks'

export interface GameDial {
  state: DialState
  /** The home side's price for the needle; null for no needle. */
  price: number | null
  /** Share of the market's life still ahead, 0-1. */
  timeLeft: number
  /** Seconds of trading left; null without a market. */
  secsLeft: number | null
  /** The dial's spoken sentence (spec 2.6). */
  label: string
}

type GameFields = Pick<
  Game,
  'status' | 'home' | 'away' | 'homeScore' | 'awayScore' | 'modelProb' | 'scheduledTipoff'
>

export function gameDial(
  game: GameFields,
  market: MarketSummary | undefined,
  startTs: number | null,
  proposed: Outcome | null,
  now: number,
): GameDial {
  const state = deriveDialState(game, market, now)
  const price = needlePrice(state, market, proposed)
  const secsLeft = secsToClose(market, now)
  const tip = Math.floor(Date.parse(game.scheduledTipoff) / 1000)
  const timeLeft = market
    ? timeLeftFraction(
        startTs ?? tip - PRE_OPEN_SECS,
        market.endTs,
        effectiveTime(now, market.priceTs ?? 0),
      )
    : 1
  const label = dialLabel({
    game,
    outcome: market?.outcome ?? null,
    price,
    modelProb: game.modelProb,
    state,
    secsLeft,
  })
  return { state, price, timeLeft, secsLeft, label }
}

/** The crown trades in these states; Sell on the PositionCard shows only then. */
export const canTrade = (state: DialState): boolean => isTrading(state)

/**
 * The crown, inline or as the sheet, stays while the market trades, and also while a send is in
 * flight. Its result stays while the market is closed or halted, the states a mid-send close
 * lands in: such a close must not take the success line, or the R2 link to a transaction that
 * may still land, with it. Sending stays off then (checkTrade says why). Once the market moves on
 * to its result, the old line goes with the crown (N2).
 */
export const crownShown = (
  state: DialState,
  t: { stage: unknown; done: unknown; error: unknown },
): boolean =>
  canTrade(state) ||
  t.stage !== null ||
  ((state === 'closed' || state === 'halted') &&
    (t.done !== null || (t.error !== undefined && t.error !== null)))
