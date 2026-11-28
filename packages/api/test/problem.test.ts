import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_HINTS, HORAGON_ERROR_CODES, HoragonError } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import {
  ApiError,
  PROBLEM_TYPE_BASE,
  problemBody,
  problemResponse,
  problemType,
  SERVER_FAULT_HINT,
  STATUS_BY_CODE,
} from '../src/problem'

describe('problem types: on the site, documented in the README', () => {
  it('points every type at www.horagon.xyz, one fragment per code', () => {
    expect(PROBLEM_TYPE_BASE).toBe('https://www.horagon.xyz/docs/errors')
    expect(problemType('NOT_FOUND')).toBe('https://www.horagon.xyz/docs/errors#not_found')
    expect(problemBody(new ApiError('MARKET_CLOSED', 'x')).type).toBe(
      'https://www.horagon.xyz/docs/errors#market_closed',
    )
    expect(problemBody(new HoragonError('INVALID_INPUT', 'x')).type).toBe(
      'https://www.horagon.xyz/docs/errors#invalid_input',
    )
    expect(problemBody(new Error('boom')).type).toBe('https://www.horagon.xyz/docs/errors#network')
  })

  it('lists every code with its status in the README table the type redirects to', () => {
    const readme = readFileSync(join(import.meta.dirname, '..', '..', '..', 'README.md'), 'utf8')
    // GitHub names the heading's anchor #api-errors, where /docs/errors redirects.
    expect(readme).toMatch(/^## API errors$/m)
    for (const code of HORAGON_ERROR_CODES) {
      const row = new RegExp(`^\\| \`${code}\` +\\| ${STATUS_BY_CODE[code]} +\\|`, 'm')
      expect(readme, code).toMatch(row)
    }
    expect(readme).not.toContain('horagon.com')
  })
})

describe('problemBody and problemResponse', () => {
  it('serializes an ApiError with its fields, status override and Retry-After', async () => {
    const err = new ApiError('RATE_LIMITED', 'Slow down', {
      hint: 'Wait',
      reason: 'R',
      programCode: 6007,
      retryAfterSecs: 2.2,
    })
    const res = problemResponse(err, 'rid-1')
    expect(res.status).toBe(429)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    expect(res.headers.get('x-request-id')).toBe('rid-1')
    expect(res.headers.get('retry-after')).toBe('3')
    expect(await res.json()).toEqual({
      type: 'https://www.horagon.xyz/docs/errors#rate_limited',
      title: 'RATE_LIMITED',
      status: 429,
      detail: 'Slow down',
      code: 'RATE_LIMITED',
      hint: 'Wait',
      programCode: 6007,
      reason: 'R',
      requestId: 'rid-1',
    })
    expect(problemBody(new ApiError('NETWORK', 'x', { status: 503 })).status).toBe(503)
    expect(problemBody(new ApiError('NOT_FOUND', 'x')).hint).toBe(DEFAULT_HINTS.NOT_FOUND)
  })

  it('never serializes the cause of an ApiError', () => {
    const cause = new Error('db down at postgres://user:pw@db.example/x')
    const body = problemBody(new ApiError('NETWORK', 'RPC call failed', { cause }))
    expect(JSON.stringify(body)).not.toMatch(/db\.example|pw|db down/)
  })

  it('redacts URLs in a HoragonError and takes its Retry-After', async () => {
    const err = new HoragonError('RATE_LIMITED', 'limited by https://rpc.example/?api-key=SECRET', {
      retryAfterSecs: 4,
      programCode: 1,
    })
    const res = problemResponse(err)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('4')
    const body = (await res.json()) as { detail: string; hint: string; programCode: number }
    expect(body.detail).not.toContain('SECRET')
    expect(body.detail).toContain('https://rpc.example/')
    expect(body).toMatchObject({ hint: err.hint, programCode: 1 })
  })

  it('answers anything else as a 500 with a server-side hint and no detail', async () => {
    const res = problemResponse(new Error('boom at https://rpc.example/?api-key=SECRET'), 'r')
    expect(res.status).toBe(500)
    expect(res.headers.get('retry-after')).toBeNull()
    const text = await res.text()
    expect(text).not.toMatch(/SECRET|rpc\.example|boom/)
    expect(JSON.parse(text)).toMatchObject({ code: 'NETWORK', hint: SERVER_FAULT_HINT })
  })
})
