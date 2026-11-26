// A3 (culture plan, rides with R7): the 404 page (string 24), in light (light branding review
// §4.12): the stopped mark, its needle in the slot.
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
    // The slot is sunk into the white face, a shade under the sheet.
    expect(html).toMatch(/<rect [^>]*class="fill-surface-sunk[^"]*"[^>]*data-slot/)
    const needle = html.match(/<line [^>]*data-needle[^>]*>/)?.[0] ?? ''
    expect(needle).toContain('stroke-ink-muted')
    // Past the scale's end (135°), straight down at 6 o'clock.
    expect(needle).toMatch(/x2="100"/)
    expect(Number(needle.match(/y2="([^"]+)"/)?.[1])).toBeGreaterThan(180)
    // Nothing live on a stopped dial: no live blue, no red. The brass is the mark's case alone.
    expect(html).not.toMatch(/(stroke|fill)-(live|lume|amber|red)/)
    expect(html.match(/stroke-brass/g)).toHaveLength(1)
  })

  it('is static: no client code', () => {
    const src = readFileSync(join(WEB, 'app', 'not-found.tsx'), 'utf8')
    expect(src).not.toContain("'use client'")
    expect(src).not.toMatch(/from 'react'/)
  })
})
