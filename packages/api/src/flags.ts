// Feature flags in the API (spec 3.3, 16.2). `provideFlags` gives each request a lazy read of the
// flags table, made at most once; `requireFlags` guards a route; `flagsOf` hands a handler the
// flags. A flag that is off answers 404 problem+json, POST routes included, before any input check.
import type { FlagName, Flags } from '@horagon/db'
import type { Context, MiddlewareHandler } from 'hono'
import { ApiError, problemResponse } from './problem'

const READER = 'horagonFlags'

export function provideFlags(read: () => Promise<Flags>): MiddlewareHandler {
  return async (c, next) => {
    let once: Promise<Flags> | undefined
    c.set(READER, () => {
      once ??= read()
      return once
    })
    await next()
  }
}

export function flagsOf(c: Context): Promise<Flags> {
  const reader = c.get(READER) as (() => Promise<Flags>) | undefined
  if (!reader) throw new Error('flagsOf: provideFlags is not installed')
  return reader()
}

export function requireFlags(...names: FlagName[]): MiddlewareHandler {
  if (names.length === 0) throw new Error('requireFlags needs at least one flag')
  return async (c, next) => {
    const flags = await flagsOf(c)
    if (names.some((name) => !flags[name])) {
      return problemResponse(
        new ApiError('NOT_FOUND', 'This feature is not available right now'),
        c.get('requestId'),
      )
    }
    await next()
  }
}
