// How the reference agent works (R2b): what it is, when it trades, and why it never counts as a
// fan. A static server page with no client module: every number comes from AGENT_PARAMS
// (lib/agent.ts), the wallet from the SDK.
import { REFERENCE_AGENT_WALLET } from '@horagon/sdk'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { BOT_RATE, AGENT_PARAMS as P } from '../../lib/agent'
import { explorerAddress } from '../../lib/format'
import { fullTitle, SITE_NAME } from '../../lib/meta'

const TITLE = 'Reference agent'
const DESCRIPTION =
  "How Horagon's disclosed reference agent trades, and why it never counts as a fan."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: fullTitle(TITLE),
    description: DESCRIPTION,
    type: 'website',
    siteName: SITE_NAME,
  },
  twitter: { title: fullTitle(TITLE), description: DESCRIPTION, card: 'summary_large_image' },
}

const REPO = 'https://github.com/horagon-labs/horagon/blob/main'
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const LINK = 'inline-flex min-h-11 items-center text-lume-300 underline-offset-4 hover:underline'
const LIST = 'list-disc space-y-1 pl-5'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-15 font-semibold text-ivory-100">{title}</h2>
      {children}
    </section>
  )
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="break-all font-mono text-13 text-ivory-100">{children}</code>
)

export default function AgentPage() {
  return (
    <article className="mx-auto max-w-2xl space-y-6 py-4 text-15 text-ash-400">
      <header className="space-y-2">
        <h1 className="text-24 font-semibold text-ivory-100">Reference agent</h1>
        <p>
          One disclosed Horagon wallet trades toward the win-probability model, so a market that
          fans leave quiet still follows the game. It never counts as a fan.
        </p>
      </header>

      <Section title="What it is">
        <ul className={LIST}>
          <li>One team wallet, run as its own process beside the keeper.</li>
          <li>Off unless enabled. It starts in a dry run: it decides and sends nothing.</li>
          <li>It pays its own fees and never uses the sponsor.</li>
        </ul>
      </Section>

      <Section title="When it trades">
        <ul className={LIST}>
          <li>It checks every {P.intervalSecs} s.</li>
          <li>
            Only live NBA winner markets that are still open: after tip-off, and never in the last{' '}
            {P.endBufferSecs / 60} min before the market's latest close (<Code>end_ts</Code>, 3 h
            after tip-off). The market itself closes at the final buzzer.
          </li>
          <li>Never at a 0:00 clock in the {P.hornFromPeriod}th quarter or overtime.</li>
          <li>The model must have been updated in the last {P.modelMaxAgeSecs} s.</li>
          <li>No other swap on that market, by any wallet, in the last {P.fanLagSecs} s.</li>
          <li>The gap between the price and the model must be over {P.band}.</li>
          <li>
            It buys YES or NO, never sells, to bring the price {P.stopShort} short of the model, or
            as far as the {P.maxPerSwapUsdc} mUSDC cap allows.
          </li>
          <li>
            If the gap grows on the same side after one of its swaps and no trade by another wallet
            is stored since, it sends nothing on that market for {P.anomalyHoldSecs / 60} min. If
            the gap is still wider then, it stops trading that market and pages the team.
          </li>
        </ul>
      </Section>

      <Section title="Limits">
        <p>
          {P.maxPerSwapUsdc} mUSDC a swap; {P.maxPerGameUsdc.toLocaleString('en-US')} mUSDC and{' '}
          {P.maxSwapsPerGame} swaps a market.
        </p>
      </Section>

      <Section title="Wallet">
        <p>
          <Code>{REFERENCE_AGENT_WALLET}</Code>
        </p>
        <a
          href={explorerAddress(REFERENCE_AGENT_WALLET)}
          target="_blank"
          rel="noreferrer"
          className={LINK}
        >
          The wallet on Solana Explorer
        </a>
      </Section>

      <Section title="Memo">
        <p>
          Every swap it sends carries a top-level SPL Memo v2 instruction (
          <Code>{MEMO_PROGRAM}</Code>) with no accounts and the data <Code>horagon:bot</Code>.
          Claims carry no memo.
        </p>
      </Section>

      <Section title="Why it never counts as a fan">
        <ul className={LIST}>
          <li>Team is checked first.</li>
          <li>
            The wallet is a <Code>team-burner</Code> entry in <Code>docs/metrics-wallets.json</Code>
            , added in a public commit before its first swap.
          </li>
          <li>The memo would make it a bot even if that listing were missed.</li>
          <li>
            The official count is <Code>node scripts/count-fans.mjs</Code>.
          </li>
        </ul>
      </Section>

      <Section title="How this site counts">
        <p>
          On a game page, a swap is the agent's when its wallet is exactly the one above, whatever
          its memo. Any other listed team wallet, and any wallet with a <Code>horagon:bot</Code>{' '}
          swap on any market or {BOT_RATE.swaps} swaps on this game within {BOT_RATE.seconds} s,
          counts as an other team or bot wallet; every other wallet is a fan.
        </p>
        <p>
          This is a live display: its rate rule looks only at this game, and{' '}
          <Code>node scripts/count-fans.mjs</Code> is the official count.
        </p>
      </Section>

      <Section title="Sources">
        <ul className={LIST}>
          <li>
            <a href={`${REPO}/docs/metrics.md`} className={LINK}>
              How fans are counted (docs/metrics.md)
            </a>
          </li>
          <li>
            <a href={`${REPO}/docs/metrics-wallets.json`} className={LINK}>
              The team wallet list (docs/metrics-wallets.json)
            </a>
          </li>
          <li>
            <a href={`${REPO}/apps/keeper/src/agent`} className={LINK}>
              The agent's code (apps/keeper/src/agent)
            </a>
          </li>
          <li>
            <a href={`${REPO}/README.md#reference-agent`} className={LINK}>
              README: Reference agent
            </a>
          </li>
        </ul>
      </Section>
    </article>
  )
}
