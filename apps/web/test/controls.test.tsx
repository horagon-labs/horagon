// Controls and states in light (light branding review §4.5, §4.7, §4.8, commit 5): a solid header,
// edges that hold 3:1 where they carry meaning and rule-faint where they only frame, four control
// states that never share a surface, milestones told apart by shape, and P&L in one ink.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Resolution } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgeCheckbox, AgeDialog } from '../components/age-dialog'
import { BoardView } from '../components/chrono/board-view'
import { DialRow } from '../components/chrono/dial-row'
import { FeelForm } from '../components/chrono/feel-toggles'
import { HoldButton } from '../components/chrono/hold-button'
import { PositionCard, type PositionCardProps } from '../components/chrono/position-card'
import { Pusher } from '../components/chrono/pusher'
import { ResolutionCard } from '../components/chrono/resolution-card'
import { Scorebug } from '../components/chrono/scorebug'
import { YourHour } from '../components/chrono/your-hour'
import { boardItem } from '../lib/chrono/board'
import { DISABLED, SELECTED, signedUsdc } from '../lib/chrono/controls'
import { DEFAULT_FEEL } from '../lib/chrono/feel'
import { detail, evening, game, market, NOW, portfolio, position } from '../lib/chrono/fixtures'
import { COLORS, contrast } from '../lib/chrono/tokens'
import { over } from './color-science'

const noop = () => {}
const root = join(import.meta.dirname, '..')
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8')
/** The class list of the first element whose tag starts like `start` and holds `marker`. */
const classAt = (html: string, marker: string) => {
  const at = html.indexOf(marker)
  const open = html.lastIndexOf('<', at)
  return html.slice(open, html.indexOf('>', at) + 1).match(/class="([^"]*)"/)?.[1] ?? ''
}

describe('header, rows and panels (review §4.8)', () => {
  it('draws the header as a solid white sheet over a rule-faint line, with no blur', () => {
    const header = read('app', 'layout.tsx').match(/<header className="([^"]+)"/)?.[1] ?? ''
    expect(header).toContain('bg-enamel-900')
    expect(header).toContain('border-rule-faint')
    expect(header).not.toMatch(/backdrop-blur|\/\d\d/)
  })

  it('edges a game row in rule (3.59) and darkens it to ink on hover and when lit', () => {
    const row = classAt(
      renderToStaticMarkup(<DialRow item={boardItem(game(), undefined, NOW)} />),
      '<a ',
    )
    expect(row).toContain('border-line')
    expect(row).toContain('hover:border-ivory-100')
    expect(row).toContain('data-[lit=true]:border-ivory-100')
    expect(row).not.toMatch(/hover:bg-|data-\[lit=true\]:bg-|\/15/)
    expect(contrast(COLORS.line, COLORS['enamel-950'])).toBeCloseTo(3.59, 2)
    expect(contrast(COLORS['ivory-100'], COLORS['enamel-950'])).toBeCloseTo(16.27, 2)
  })

  it('frames the scorebug, the resolution card and the position card in rule-faint', () => {
    const r = resolution()
    for (const html of [
      renderToStaticMarkup(<Scorebug game={detail()} run={null} />),
      renderToStaticMarkup(<ResolutionCard game={detail({ resolutions: [r] })} state="proposed" />),
      card(),
    ]) {
      const section = classAt(html, '<section')
      expect(section).toContain('border-rule-faint')
      expect(section).not.toContain('/15')
    }
  })

  it('edges the header chips in rule (3.89 on the white header), words in ink, ◆ in live', () => {
    const chip = classAt(
      renderToStaticMarkup(<YourHour portfolio={portfolio([position()])} onOpen={noop} />),
      '<button',
    )
    expect(chip).toContain('border-line')
    expect(chip).toContain('text-ivory-100')
    expect(chip).not.toMatch(/lume-300|\/40/)
    const wallet = read('components', 'wallet-button.tsx')
    expect(wallet).toMatch(/border border-line px-4 text-13 text-brass-400/)
    expect(wallet).not.toContain('border-brass-500/40')
    expect(contrast(COLORS.line, COLORS['enamel-900'])).toBeCloseTo(3.89, 2)
  })

  it('edges every dialog in ink-muted over the 30 % ink scrim (3.42 on the scrimmed page)', () => {
    const age = renderToStaticMarkup(
      <AgeDialog open={false} error={undefined} onConfirm={noop} onCancel={noop} />,
    )
    expect(classAt(age, '<dialog')).toContain('border-ash-400')
    for (const file of ['age-dialog.tsx', 'wallet-button.tsx', 'chrono/crown-sheet.tsx']) {
      const text = read('components', file)
      expect(text, file).toMatch(/border-ash-400 bg-enamel-900 [^"]*backdrop:bg-ivory-100\/30/)
      expect(text, file).not.toContain('border-brass-500/20')
    }
    const page = over(COLORS['ivory-100'], 0.3, COLORS['enamel-950'])
    expect(page).toBe('#b4b4b2')
    expect(contrast(COLORS['ash-400'], page)).toBeCloseTo(3.42, 2)
  })

  it('keeps only the alpha lines the review keeps (§4.8)', () => {
    const kept = [
      'border-lume-300/50', // faucet, A1 owns it
      'border-lume-300/60', // Pusher home edge, A1
      'border-brass-500/60', // Pusher away edge, A1
      'border-amber-400/50', // "Get a new quote"
      'stroke-enamel-950/25', // HoldButton track on the ink fill
      'stroke-lume-300/70', // bezel progress
      'backdrop:bg-ivory-100/30', // the three scrims
    ]
    const found = new Set<string>()
    for (const dir of ['app', 'components']) {
      for (const file of readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })) {
        if (!/\.tsx?$/.test(file)) continue
        for (const m of read(dir, file).matchAll(/[\w:[\]=-]+-[a-z]+-\d{2,3}\/\d{2}\b/g)) {
          found.add(m[0])
        }
      }
    }
    expect([...found].sort()).toEqual([...kept].sort())
  })
})

describe('the four control states (review §4.5)', () => {
  it('spells disabled as a clear fill, a dashed rule edge and ink-muted words', () => {
    expect(DISABLED.split(' ').sort()).toEqual(
      [
        'disabled:bg-transparent',
        'disabled:border',
        'disabled:border-dashed',
        'disabled:border-line',
        'disabled:text-ash-400',
      ].sort(),
    )
    expect(DISABLED).not.toContain('opacity')
    expect(contrast(COLORS['ash-400'], COLORS['enamel-950'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(COLORS.line, COLORS['enamel-950'])).toBeGreaterThanOrEqual(3)
  })

  it('spells selected as the sunk fill under a 2 px ink edge', () => {
    expect(SELECTED.split(' ').sort()).toEqual(
      [
        'aria-pressed:bg-enamel-800',
        'aria-pressed:border-2',
        'aria-pressed:border-ivory-100',
      ].sort(),
    )
    expect(contrast(COLORS['ivory-100'], COLORS['enamel-800'])).toBeCloseTo(14.9, 1)
  })

  it('draws the five Phase 1 disabled buttons in that look, never by opacity', () => {
    const age = renderToStaticMarkup(
      <AgeDialog open={false} error={undefined} onConfirm={noop} onCancel={noop} />,
    )
    const hold = renderToStaticMarkup(<HoldButton label="Buy CLE" onConfirm={noop} disabled />)
    const faucet = renderToStaticMarkup(
      <Pusher
        mode={{ kind: 'faucet' }}
        home="CLE"
        away="MEM"
        price={0.77}
        onPick={noop}
        funding
        onFaucet={noop}
      />,
    )
    const locked = renderToStaticMarkup(
      <Pusher
        mode={{ kind: 'buy', locked: true, note: null }}
        home="CLE"
        away="MEM"
        price={0.77}
        onPick={noop}
        funding={false}
        onFaucet={noop}
      />,
    )
    for (const [name, cls] of [
      ['Continue', classAt(age, '>Continue<')],
      ['HoldButton', classAt(hold, 'hold-safe')],
      ['faucet', classAt(faucet, '<button')],
      ['Pusher', classAt(locked, '<button')],
    ] as const) {
      for (const c of DISABLED.split(' ')) expect(cls, name).toContain(c)
      expect(cls, name).not.toContain('opacity')
    }
    // The crown's one-tap set-up button: the fifth line (crown-panel.tsx).
    expect(read('components', 'chrono', 'crown-panel.tsx')).toMatch(
      /text-15 font-semibold text-enamel-950 \$\{DISABLED\}/,
    )
  })

  it('keeps the hold ring readable on a disabled button: rule-faint track, ink-muted progress', () => {
    const hold = renderToStaticMarkup(<HoldButton label="Buying…" onConfirm={noop} pending />)
    expect(classAt(hold, 'hold-safe')).toMatch(/(^| )group( |$)/)
    expect(hold).toContain('stroke-enamel-950/25 group-disabled:stroke-rule-faint')
    expect(classAt(hold, 'data-progress')).toContain('group-disabled:stroke-ash-400')
  })

  it('leaves opacity on the six Phase 2 lines only (exempt as inactive, §4.5)', () => {
    const left: string[] = []
    for (const dir of ['app', 'components']) {
      for (const file of readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })) {
        if (!/\.tsx?$/.test(file)) continue
        const n = read(dir, file).match(/disabled:opacity-\d+/g)?.length ?? 0
        for (let i = 0; i < n; i++) left.push(file.replaceAll('\\', '/'))
      }
    }
    expect(left.sort()).toEqual(
      [
        'chrono/crown-panel.tsx', // Buy/Sell chips
        'chrono/crown-panel.tsx', // the inline faucet link
        'positions.tsx',
        'wallet-button.tsx',
        'wallet-sheet.tsx',
        'wallet-sheet.tsx',
      ].sort(),
    )
  })

  it('marks the picked Pusher side, the crown chips and the follow chips as selected', () => {
    const desk = renderToStaticMarkup(
      <Pusher
        mode={{ kind: 'buy', locked: false, note: null }}
        home="CLE"
        away="MEM"
        price={0.77}
        onPick={noop}
        selected="away"
        funding={false}
        onFaucet={noop}
      />,
    )
    for (const c of SELECTED.split(' '))
      expect(classAt(desk, 'aria-pressed="true"'), c).toContain(c)
    expect(read('components', 'chrono', 'crown-panel.tsx')).toMatch(
      /font-mono text-13 \$\{SELECTED\} disabled:opacity-40/,
    )
    const board = renderToStaticMarkup(
      <BoardView
        games={evening()}
        portfolio={undefined}
        now={NOW}
        health={{ stale: false, error: undefined }}
        follows={['CLE']}
        onToggleFollow={noop}
        selectedId={null}
        onSelect={noop}
        hoverId={null}
        onHover={noop}
      />,
    )
    const chip = classAt(board, 'aria-pressed="true"')
    for (const c of SELECTED.split(' ')) expect(chip, c).toContain(c)
    expect(board).toContain('>★ CLE</button>')
  })

  it('shows focus on the crown amount field through its edge (it has no outline of its own)', () => {
    const crown = read('components', 'chrono', 'crown-panel.tsx')
    expect(crown).toMatch(
      /<label className="[^"]*border border-line[^"]*focus-within:border-ivory-100[^"]*">\s*<input\s+inputMode="decimal"/,
    )
  })

  it('ticks the 18+ box and the feel switches in ink (native box, unticked edge left to the browser)', () => {
    const box = renderToStaticMarkup(<AgeCheckbox checked={false} onChange={noop} />)
    expect(box).toContain('accent-ivory-100')
    expect(box).not.toContain('checked=""')
    const feel = renderToStaticMarkup(<FeelForm feel={DEFAULT_FEEL} onChange={noop} vibrates />)
    expect(feel).toContain('accent-ivory-100')
    for (const html of [box, feel]) expect(html).not.toContain('accent-lume-300')
    expect(contrast('#767676', COLORS['enamel-900'])).toBeCloseTo(4.54, 2)
  })
})

function resolution(over: Partial<Resolution> = {}): Resolution {
  return {
    market: market().pubkey,
    kind: 'winner',
    status: 'proposed',
    outcome: null,
    evidenceHash: null,
    evidenceUrl: null,
    createSig: null,
    haltSig: null,
    proposeSig: '5'.repeat(88),
    finalizeSig: null,
    recycleSig: null,
    externalLp: false,
    ...over,
  }
}

describe('resolution milestones by shape (review §4.7)', () => {
  const html = renderToStaticMarkup(
    <ResolutionCard game={detail({ resolutions: [resolution()] })} state="proposed" />,
  )
  const dot = (mark: string) => {
    const li = html.slice(html.indexOf(`data-mark="${mark}"`))
    return li.match(/<span aria-hidden="true" class="([^"]*)"/)?.[1] ?? ''
  }

  it('fills done in ink, rings now in 2 px ink, rings next in 1 px rule', () => {
    expect(dot('done')).toBe('size-2 rounded-full bg-ivory-100')
    expect(dot('now')).toBe('size-2.5 rounded-full border-2 border-ivory-100')
    expect(dot('next')).toBe('size-2 rounded-full border border-line')
  })

  it('sets the label of now in weight 600, and tells the marks apart with no hue at all', () => {
    const now = html.slice(html.indexOf('data-mark="now"'))
    expect(now).toMatch(/^data-mark="now"><span[^>]*><\/span><span class="[^"]*font-semibold/)
    for (const mark of ['done', 'now', 'next']) {
      expect(dot(mark)).not.toMatch(/lume-300|amber-400|live|red-400/)
    }
    expect(new Set(['done', 'now', 'next'].map(dot)).size).toBe(3)
  })
})

const card = (over: Partial<PositionCardProps> = {}) =>
  renderToStaticMarkup(
    <PositionCard
      gameId="nba-401810001"
      teams={{ home: 'CLE', away: 'MEM' }}
      portfolio={portfolio([position()])}
      canSell
      onSell={noop}
      claiming={false}
      claimed={[]}
      claimError={undefined}
      onClaim={noop}
      {...over}
    />,
  )

describe('P&L in one ink, the sign printed (review §4.7, u3 D2)', () => {
  it('prints + for a gain and the minus sign (U+2212) for a loss', () => {
    expect(signedUsdc('0.857')).toBe('+0.85')
    expect(signedUsdc('-1.2')).toBe('−1.20')
    expect(signedUsdc('-0.004')).toBe('−0.00')
    expect(signedUsdc('0')).toBe('+0.00')
    expect(signedUsdc('1234.5')).toBe('+1,234.50')
  })

  it('sets both signs in ink, never in a win or loss hue', () => {
    const up = card()
    const down = card({ portfolio: portfolio([position({ pnlUsdc: '-1.2' })]) })
    expect(up).toContain('<span class="text-ivory-100">(+0.85)</span>')
    expect(down).toContain('<span class="text-ivory-100">(−1.20)</span>')
    for (const html of [up, down]) expect(html).not.toMatch(/text-red-400|text-lume-300/)
  })
})
