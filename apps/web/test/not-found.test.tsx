// A3 (culture plan, rides with R7): the 404 page (string 24).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import NotFound from '../app/not-found'

const WEB = join(import.meta.dirname, '..')

describe('the 404 page (string 24)', () => {
  it('says Air ball, links back to the board, and draws the needle fallen into the slot', () => {
    const html = renderToStaticMarkup(<NotFound />)
    expect(html).toContain('Air ball. Nothing on the clock at this address.')
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Back to tonight&#x27;s games<\/a>/)
    expect(html).toContain('data-slot')
    expect(html).toContain('class="fill-enamel-950"')
    const needle = html.match(/<line [^>]*data-needle[^>]*>/)?.[0] ?? ''
    expect(needle).toContain('stroke-ash-400')
    // Past the scale's end (135°), straight down at 6 o'clock.
    expect(needle).toMatch(/x2="100"/)
    expect(Number(needle.match(/y2="([^"]+)"/)?.[1])).toBeGreaterThan(180)
    expect(html).not.toMatch(/stroke-(lume|brass|amber|red)/)
  })

  it('is static: no client code', () => {
    const src = readFileSync(join(WEB, 'app', 'not-found.tsx'), 'utf8')
    expect(src).not.toContain("'use client'")
    expect(src).not.toMatch(/from 'react'/)
  })
})
