import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgeDialog } from '../components/age-dialog'
import { FeelForm } from '../components/chrono/feel-toggles'
import { Wordmark } from '../components/chrono/wordmark'
import { YourHour } from '../components/chrono/your-hour'
import { PlayMoneyBanner } from '../components/play-money-banner'
import { DEFAULT_FEEL } from '../lib/chrono/feel'
import { portfolio, position } from '../lib/chrono/fixtures'

const noop = () => {}

describe('app shell (spec 2.7, 3.2)', () => {
  it('spells the wordmark in brass after a hidden hourglass', () => {
    const html = renderToStaticMarkup(<Wordmark />)
    expect(html).toContain('text-brass-500')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('>HORAGON</span>')
  })

  it('keeps the play-money banner’s words exactly', () => {
    const html = renderToStaticMarkup(<PlayMoneyBanner />)
    expect(html).toContain('role="note"')
    expect(html).toContain('>Play-money on devnet. No real value. No prizes.</div>')
  })

  it('keeps every word of the 18+ dialog and drops the old light theme', () => {
    const html = renderToStaticMarkup(
      <AgeDialog open={false} error={undefined} onConfirm={noop} onCancel={noop} />,
    )
    for (const words of [
      'Before you play',
      'Horagon is play money on Solana devnet. No real value. No prizes.',
      'I am 18 or older',
      'Not now',
      'Continue',
    ]) {
      expect(html).toContain(words)
    }
    expect(html).not.toContain('dark:')
    expect(html).not.toContain('bg-white')
  })
})

describe('YourHour (spec 3.2)', () => {
  const two = portfolio([
    position(),
    position({ market: 'Mkt2222222222222222222222222222222222222222', valueUsdc: '2.043' }),
  ])

  it('shows the open positions and their value now', () => {
    const html = renderToStaticMarkup(<YourHour portfolio={two} onOpen={noop} />)
    expect(html).toContain('>◆ 2 · 12.90</button>')
    expect(html).toContain('aria-label="2 open positions, worth 12.90 mUSDC"')
  })

  it('says position for one, and nothing at all without a wallet', () => {
    const one = renderToStaticMarkup(<YourHour portfolio={portfolio([position()])} onOpen={noop} />)
    expect(one).toContain('aria-label="1 open position, worth 10.85 mUSDC"')
    expect(renderToStaticMarkup(<YourHour portfolio={undefined} onOpen={noop} />)).toBe('')
  })
})

describe('FeelForm (spec 2.5)', () => {
  const form = (vibrates: boolean) =>
    renderToStaticMarkup(<FeelForm feel={DEFAULT_FEEL} onChange={noop} vibrates={vibrates} />)

  it('offers haptics only where the device can vibrate, on by default', () => {
    expect(form(false)).not.toContain('Haptics')
    expect(form(true)).toMatch(/Haptics<input type="checkbox" class="[^"]+" checked=""/)
  })

  it('starts with the tick sound off and motion like the device', () => {
    const html = form(true)
    expect(html).toMatch(/Tick sound<input type="checkbox" class="[^"]+"\/>/)
    expect(html).toContain('<option value="system" selected="">Like this device</option>')
  })
})
