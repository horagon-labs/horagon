// The Content-Security-Policy (R9): a fresh nonce per request, scripts only by that nonce and
// what they load ('strict-dynamic'), and the browser talks only to the API base. The burner's
// key sits in localStorage, so an injected script must not run and must not reach another host.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { API_BASE, connectSources, contentSecurityPolicy, newNonce } from '../lib/csp'
import { config, proxy } from '../proxy'

const WEB = resolve(import.meta.dirname, '..')

const directives = (policy: string) =>
  new Map(
    policy.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/)
      return [name as string, values]
    }),
  )

describe('contentSecurityPolicy', () => {
  const policy = contentSecurityPolicy({ nonce: 'abc123', dev: false, apiBase: '/api/v1' })
  const d = directives(policy)

  it('runs scripts by the nonce and what they load, never by eval or inline text', () => {
    expect(d.get('script-src')).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"])
    expect(policy).not.toContain('unsafe-eval')
    expect(d.get('script-src')).not.toContain("'unsafe-inline'")
  })

  it('locks plugins, base, forms and framing', () => {
    expect(d.get('default-src')).toEqual(["'self'"])
    expect(d.get('object-src')).toEqual(["'none'"])
    expect(d.get('base-uri')).toEqual(["'self'"])
    expect(d.get('form-action')).toEqual(["'self'"])
    expect(d.get('frame-ancestors')).toEqual(["'none'"])
  })

  it('loads images, fonts and styles from this origin only', () => {
    expect(d.get('img-src')).toEqual(["'self'"])
    expect(d.get('font-src')).toEqual(["'self'"])
    // React writes style="" attributes in the server HTML (motion's first frame); they carry no
    // nonce. Script stays strict; images and fonts stay same-origin, so CSS cannot send data out.
    expect(d.get('style-src')).toEqual(["'self'", "'unsafe-inline'"])
  })

  it('connects to this origin only while the API is same-origin', () => {
    expect(d.get('connect-src')).toEqual(["'self'"])
  })

  it('adds the API origin when NEXT_PUBLIC_API_BASE is absolute', () => {
    const other = directives(
      contentSecurityPolicy({ nonce: 'n', dev: false, apiBase: 'https://api.example.org/v1/' }),
    )
    expect(other.get('connect-src')).toEqual(["'self'", 'https://api.example.org'])
  })

  it("adds 'unsafe-eval' in development only (React's error overlay)", () => {
    const dev = directives(contentSecurityPolicy({ nonce: 'n', dev: true, apiBase: '/api/v1' }))
    expect(dev.get('script-src')).toEqual([
      "'self'",
      "'nonce-n'",
      "'strict-dynamic'",
      "'unsafe-eval'",
    ])
  })

  it('is one header line with no empty directive', () => {
    expect(policy).not.toMatch(/[\r\n]/)
    for (const [name, values] of d) {
      expect(name).toMatch(/^[a-z-]+$/)
      expect(values.length, name).toBeGreaterThan(0)
    }
  })
})

describe('connectSources', () => {
  it('keeps a relative base same-origin', () => {
    expect(connectSources('/api/v1')).toEqual(["'self'"])
  })

  it('takes the origin of an absolute http(s) base, path and query dropped', () => {
    expect(connectSources('https://api.example.org:8443/api/v1?x=1')).toEqual([
      "'self'",
      'https://api.example.org:8443',
    ])
    expect(connectSources('http://127.0.0.1:3001/api/v1')).toEqual([
      "'self'",
      'http://127.0.0.1:3001',
    ])
  })

  it('lets no other scheme or a broken URL widen the list', () => {
    for (const base of [
      'javascript:alert(1)',
      'data:text/plain,x',
      'ws://x.example',
      '//x.example',
    ]) {
      expect(connectSources(base), base).toEqual(["'self'"])
    }
  })

  it('reads the same base the browser client uses', () => {
    expect(API_BASE).toBe(process.env.NEXT_PUBLIC_API_BASE ?? '/api/v1')
    expect(readFileSync(join(WEB, 'lib', 'api.ts'), 'utf8')).toMatch(/baseUrl: API_BASE,/)
  })
})

describe('no eval in the browser', () => {
  it("turns off zod's Function('') probe before the SDK builds its schemas", () => {
    // Without it every page load logs a script-src violation (the probe is caught, but noisy).
    // instrumentation-client.ts runs before the app's modules; the probe runs when the SDK's
    // object schemas are built, at import.
    const src = readFileSync(join(WEB, 'instrumentation-client.ts'), 'utf8')
    expect(src).toMatch(/^import \{ config \} from 'zod\/v4\/core'$/m)
    expect(src).toMatch(/^config\(\{ jitless: true \}\)$/m)
  })
})

describe('newNonce', () => {
  it('is 128 random bits in base64, new every call', () => {
    const seen = new Set(Array.from({ length: 64 }, () => newNonce()))
    expect(seen.size).toBe(64)
    for (const n of seen) {
      expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/)
      expect(atob(n)).toHaveLength(16)
    }
  })
})

describe('proxy', () => {
  it('sends the policy and hands the same nonce to the render', () => {
    const res = proxy(new NextRequest('http://localhost:3000/game/abc'))
    const sent = res.headers.get('content-security-policy') ?? ''
    const nonce = /'nonce-([^']+)'/.exec(sent)?.[1]
    expect(nonce).toBeTruthy()
    // NextResponse.next({ request: { headers } }) passes request headers to the render this way;
    // Next reads the nonce for its own scripts from the request's policy.
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(sent)
    expect(res.headers.get('x-middleware-override-headers')).toContain('content-security-policy')
  })

  it('draws a fresh nonce per request', () => {
    const a = proxy(new NextRequest('http://localhost:3000/')).headers.get(
      'content-security-policy',
    )
    const b = proxy(new NextRequest('http://localhost:3000/')).headers.get(
      'content-security-policy',
    )
    expect(a).not.toBe(b)
  })

  const matches = (path: string) =>
    config.matcher.some((m) => new RegExp(`^${m.source}$`).test(path))

  it('runs for pages, not for the API, static files or images', () => {
    for (const page of ['/', '/game/abc', '/me', '/agent', '/no-such-page']) {
      expect(matches(page), page).toBe(true)
    }
    for (const file of [
      '/api/v1/health',
      '/_next/static/chunks/a.js',
      '/_next/image',
      '/favicon.ico',
      '/icons/icon-192.png',
      '/icon.svg',
      '/manifest.webmanifest',
    ]) {
      expect(matches(file), file).toBe(false)
    }
  })

  it('skips router prefetches, which carry no HTML', () => {
    for (const m of config.matcher) {
      expect(m.missing).toEqual(
        expect.arrayContaining([{ type: 'header', key: 'next-router-prefetch' }]),
      )
    }
  })
})

describe('every page renders per request, so each gets its nonce', () => {
  it('the root layout waits for the request', () => {
    const layout = readFileSync(join(WEB, 'app', 'layout.tsx'), 'utf8')
    expect(layout).toMatch(/export default async function RootLayout/)
    expect(layout).toMatch(/await connection\(\)/)
  })
})

describe('the browser reaches only the API base', () => {
  // Code that can run in the browser: everything under app/, components/ and lib/ except server
  // code (lib/server, route handlers, image routes). The API client is lib/api.ts.
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(name)) files.push(p)
    }
  }
  for (const dir of ['app', 'components', 'lib']) walk(join(WEB, dir))
  const browser = files.filter((f) => {
    const r = relative(WEB, f).replaceAll('\\', '/')
    return !(
      r.startsWith('lib/server/') ||
      /\/route\.tsx?$/.test(r) ||
      /(opengraph|twitter|apple)-image\.tsx$/.test(r)
    )
  })

  it('has no network call of its own (fetch, sockets, beacons, RPC connections)', () => {
    expect(browser.length).toBeGreaterThan(20)
    for (const f of browser) {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      for (const pattern of [
        /\bfetch\(/,
        /new Connection\(/,
        /WebSocket/,
        /EventSource/,
        /XMLHttpRequest/,
        /sendBeacon/,
      ]) {
        expect(code, `${relative(WEB, f)} ${pattern}`).not.toMatch(pattern)
      }
    }
  })
})
