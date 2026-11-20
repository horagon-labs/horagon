import { DEFAULT_HINTS, HoragonError } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { ApiError, problemBody, problemResponse, SERVER_FAULT_HINT } from '../src/problem'

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
      type: 'https://horagon.com/docs/errors#rate_limited',
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
