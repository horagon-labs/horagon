import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLAY_MONEY_NOTICE } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { dynamicParams, GET, generateStaticParams } from '../app/icons/[file]/route'
import manifest from '../app/manifest'
import { AgeDialog } from '../components/age-dialog'
import { HomeIcon, MARK_NEEDLE } from '../components/chrono/dial-mark'
import { FeelForm } from '../components/chrono/feel-toggles'
import { Wordmark } from '../components/chrono/wordmark'
import { YourHour } from '../components/chrono/your-hour'
import { PlayMoneyBanner } from '../components/play-money-banner'
import { DEFAULT_FEEL } from '../lib/chrono/feel'
import { portfolio, position } from '../lib/chrono/fixtures'
import { COLORS } from '../lib/chrono/tokens'
import { ICON_COLORS, ICON_SIZES, iconSize } from '../lib/icons'

const noop = () => {}

describe('app shell (spec 2.7, 3.2)', () => {
  it('spells the wordmark in brass after the hidden dial mark of the icon (R5)', () => {
    const html = renderToStaticMarkup(<Wordmark />)
    expect(html).toContain('text-brass-500')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain(`d="${MARK_NEEDLE}"`)
    expect(html).toContain('>HORAGON</span>')
    const icon = readFileSync(join(import.meta.dirname, '..', 'app', 'icon.svg'), 'utf8')
    expect(icon).toContain(`d="${MARK_NEEDLE}"`)
  })

  it('names the app for a home screen (R5)', () => {
    const m = manifest()
    expect(m.short_name).toBe('Horagon')
    expect(m.start_url).toBe('/')
    expect(m.display).toBe('standalone')
    expect(m.icons?.map((i) => i.src)).toEqual([
      '/icon.svg',
      '/apple-icon',
      '/icons/icon-192.png',
      '/icons/icon-512.png',
    ])
    // Android's install prompt asks for 192 and 512 px PNGs (R5 review finding 12).
    expect(m.icons?.slice(2)).toEqual([
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ])
  })

  it('draws the manifest PNGs in the dial mark, one file per size, built once', () => {
    expect(ICON_SIZES).toEqual([192, 512])
    expect(iconSize('icon-192.png')).toBe(192)
    expect(iconSize('icon-512.png')).toBe(512)
    expect(iconSize('icon-180.png')).toBeNull()
    expect(iconSize('../icon.svg')).toBeNull()
    expect(generateStaticParams()).toEqual([{ file: 'icon-192.png' }, { file: 'icon-512.png' }])
    expect(dynamicParams).toBe(false)
    const html = renderToStaticMarkup(<HomeIcon px={512} colors={ICON_COLORS} />)
    expect(html).toContain('data-home-icon="512"')
    expect(html).toContain(`d="${MARK_NEEDLE}"`)
    expect(html).toContain('width="420"')
    expect(html).toContain(`stroke="${COLORS.live}"`)
  })

  it('answers 404 for an icon size it does not draw', async () => {
    const res = await GET(new Request('http://x/icons/icon-64.png'), {
      params: Promise.resolve({ file: 'icon-64.png' }),
    })
    expect(res.status).toBe(404)
  })

  const root = join(import.meta.dirname, '..')
  const sources = ['app', 'components', 'lib'].flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(tsx?|css)$/.test(file))
      .map((file) => join(dir, file)),
  )

  it('sets no text under 12 px (R5)', () => {
    // SVG <text> scales with its dial's viewBox; it is checked on the dials themselves.
    const small = sources.filter((file) =>
      /text-11(?![0-9])|text-\[(?:[0-9]|1[01])px\]/.test(
        readFileSync(join(root, file), 'utf8').replace(/<text[\s\S]*?<\/text>/g, ''),
      ),
    )
    expect(small).toEqual([])
  })

  it('takes the banner words from PLAY_MONEY_NOTICE, the one copy, in the SDK', () => {
    expect(sources.length).toBeGreaterThan(10)
    const copies = sources.filter((file) =>
      readFileSync(join(root, file), 'utf8').includes(PLAY_MONEY_NOTICE),
    )
    expect(copies).toEqual([])
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
    // One flex item, so the inline-flex header chip keeps the space after the ◆.
    expect(html).toContain('><span><span class="text-live">◆</span> 2 · 12.90</span></button>')
    expect(html).toContain('aria-label="2 open positions, worth 12.90 mUSDC"')
  })

  it('says position for one, and nothing at all without a wallet', () => {
    const one = renderToStaticMarkup(<YourHour portfolio={portfolio([position()])} onOpen={noop} />)
    expect(one).toContain('aria-label="1 open position, worth 10.85 mUSDC"')
    expect(renderToStaticMarkup(<YourHour portfolio={undefined} onOpen={noop} />)).toBe('')
  })

  it('fits the 375 px header with a wallet: chips never wrap, YourHour and the address from sm', () => {
    const html = renderToStaticMarkup(
      <YourHour portfolio={two} onOpen={noop} className="hidden sm:inline-flex" />,
    )
    expect(html).toMatch(/class="[^"]*shrink-0 [^"]*whitespace-nowrap[^"]*hidden sm:inline-flex"/)
    // Centred in its pill once the header makes it a flex box.
    expect(html).toMatch(/class="[^"]*items-center[^"]*hidden sm:inline-flex"/)
    const button = readFileSync(
      join(import.meta.dirname, '..', 'components', 'wallet-button.tsx'),
      'utf8',
    )
    // Below sm the sheet lists the positions and shows the address: the balance pill alone fits.
    expect(button).toContain(
      '<YourHour portfolio={own} onOpen={() => open(true)} className="hidden sm:inline-flex" />',
    )
    expect(button).toMatch(/className="[^"]*shrink-0 whitespace-nowrap[^"]*"\s*>\s*\{balance/)
    expect(button).toContain('<span className="hidden sm:inline"> · {shortKey(address)}</span>')
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
