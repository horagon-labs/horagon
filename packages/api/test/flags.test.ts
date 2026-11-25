import { createRoute, z } from '@hono/zod-openapi'
import { allFlagsOff, FLAG_NAMES, setFlag } from '@horagon/db'
import { FlagsResponseSchema } from '@horagon/sdk'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { flagsOf, provideFlags, requireFlags } from '../src/flags'
import { makeEnv, type TestEnv } from './helpers'

let env: TestEnv
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  env = await makeEnv()
  app = createApp(env.deps)
  // Probe routes behind flags, declared the way Tier 2 routes declare theirs.
  app.get('/probe', requireFlags('FLAG_ME'), (c) => c.json({ ok: true }))
  app.get('/probe-two', requireFlags('FLAG_ME', 'FLAG_SHARE'), (c) => c.json({ ok: true }))
  app.openapi(
    createRoute({
      method: 'post',
      path: '/probe',
      middleware: [requireFlags('FLAG_ME')] as const,
      request: {
        body: {
          content: { 'application/json': { schema: z.strictObject({ n: z.number() }) } },
          required: true,
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: z.object({ n: z.number() }) } },
          description: 'Echo',
        },
      },
    }),
    (c) => c.json({ n: c.req.valid('json').n }, 200),
  )
})
afterEach(async () => {
  await env.h.close()
})

const get = (path: string) => app.request(`/api/v1${path}`)
const post = (path: string, body: unknown) =>
  app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** A route whose flag is off: 404 problem+json with the request id, like any unknown route. */
async function expectOff(res: Response) {
  expect(res.status).toBe(404)
  expect(res.headers.get('content-type')).toBe('application/problem+json')
  const body = (await res.json()) as { status: number; code: string; requestId?: string }
  expect(body).toMatchObject({ status: 404, code: 'NOT_FOUND' })
  expect(body.requestId).toBe(res.headers.get('x-request-id'))
}

describe('GET /api/v1/flags', () => {
  it('answers every flag, off by default, never cached', async () => {
    const res = await get('/flags')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(FlagsResponseSchema.parse(await res.json())).toEqual({ flags: allFlagsOff() })
  })

  it('shows a change at once, with the same app', async () => {
    await setFlag(env.h.db, 'FLAG_METRICS', true, 'ops')
    const body = FlagsResponseSchema.parse(await (await get('/flags')).json())
    expect(body.flags).toEqual({ ...allFlagsOff(), FLAG_METRICS: true })
  })

  it('has a schema with exactly the flags of FLAG_NAMES', () => {
    expect(Object.keys(FlagsResponseSchema.shape.flags.shape)).toEqual([...FLAG_NAMES])
  })
})

describe('requireFlags', () => {
  it('answers 404 problem+json to a GET and a POST while the flag is off', async () => {
    await expectOff(await get('/probe'))
    await expectOff(await post('/probe', { n: 1 }))
  })

  it('checks the flag before the body: an invalid body still gets 404, not 400', async () => {
    await expectOff(await post('/probe', { wrong: true }))
  })

  // Review Focus #3: a flag turned off mid-night, with the page still open.
  it('turns a route off mid-night: 200 while on, 404 problem+json once off, same app', async () => {
    await setFlag(env.h.db, 'FLAG_ME', true, 'ops')
    expect((await get('/probe')).status).toBe(200)
    expect(await (await post('/probe', { n: 7 })).json()).toEqual({ n: 7 })
    await setFlag(env.h.db, 'FLAG_ME', false, 'ops')
    await expectOff(await get('/probe'))
    await expectOff(await post('/probe', { n: 7 }))
  })

  it('needs every flag it names', async () => {
    await setFlag(env.h.db, 'FLAG_ME', true, 'ops')
    await expectOff(await get('/probe-two'))
    await setFlag(env.h.db, 'FLAG_SHARE', true, 'ops')
    expect((await get('/probe-two')).status).toBe(200)
  })

  it('refuses to guard a route with no flag', () => {
    expect(() => requireFlags()).toThrow('requireFlags needs at least one flag')
  })

  it('leaves the Tier 1 routes alone while every flag is off', async () => {
    expect((await get('/games')).status).toBe(200)
  })
})

describe('flagsOf', () => {
  it('reads the flags once per request, however many guards and handlers ask', async () => {
    let reads = 0
    const mini = new Hono()
    mini.use(
      '*',
      provideFlags(async () => {
        reads++
        return { ...allFlagsOff(), FLAG_ME: true, FLAG_SHARE: true }
      }),
    )
    mini.get('/x', requireFlags('FLAG_ME'), requireFlags('FLAG_SHARE'), async (c) =>
      c.json({ me: (await flagsOf(c)).FLAG_ME }),
    )
    expect(await (await mini.request('/x')).json()).toEqual({ me: true })
    expect(reads).toBe(1)
    await mini.request('/x')
    expect(reads).toBe(2)
  })

  it('throws when provideFlags is not installed', async () => {
    const bare = new Hono()
    bare.get('/x', async (c) => c.json(await flagsOf(c)))
    bare.onError((err, c) => c.text(err.message, 500))
    const res = await bare.request('/x')
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('flagsOf: provideFlags is not installed')
  })
})
