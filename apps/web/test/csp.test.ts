// The Content-Security-Policy (R9): a fresh nonce per request, scripts only by that nonce and
// what they load ('strict-dynamic'), and the browser talks only to the API base, except on
// /verify/<market>, which reads the chain and the evidence from the viewer's browser. The burner's
// key sits in localStorage, so an injected script must not run and must not reach another host.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { API_BASE, connectSources, contentSecurityPolicy, isVerifyPage, newNonce } from '../lib/csp'
import { config, proxy } from '../proxy'

const WEB = resolve(import.meta.dirname, '..')
/** A /verify page for a real-looking market address (base58, 32 bytes). */
const VERIFY = '/verify/7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'

const directives = (policy: string) =>
  new Map(
    policy.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/)
      return [name as string, values]
    }),
  )

describe('contentSecurityPolicy', () => {
  const policy = contentSecurityPolicy({
    nonce: 'abc123',
    dev: false,
    apiBase: '/api/v1',
    pathname: '/',
  })
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
      contentSecurityPolicy({
        nonce: 'n',
        dev: false,
        apiBase: 'https://api.example.org/v1/',
        pathname: '/',
      }),
    )
    expect(other.get('connect-src')).toEqual(["'self'", 'https://api.example.org'])
  })

  it("adds 'unsafe-eval' in development only (React's error overlay)", () => {
    const dev = directives(
      contentSecurityPolicy({ nonce: 'n', dev: true, apiBase: '/api/v1', pathname: '/' }),
    )
    expect(dev.get('script-src')).toEqual([
      "'self'",
      "'nonce-n'",
      "'strict-dynamic'",
      "'unsafe-eval'",
    ])
  })

  it('adds https: to connect-src on a /verify page only, every other directive unchanged', () => {
    const verify = directives(
      contentSecurityPolicy({ nonce: 'abc123', dev: false, apiBase: '/api/v1', pathname: VERIFY }),
    )
    expect(verify.get('connect-src')).toEqual(["'self'", 'https:'])
    for (const [name, values] of d) {
      if (name !== 'connect-src') expect(verify.get(name), name).toEqual(values)
    }
    expect([...verify.keys()]).toEqual([...d.keys()])
  })

  it('keeps the API origin beside https: on a /verify page', () => {
    const verify = directives(
      contentSecurityPolicy({
        nonce: 'n',
        dev: false,
        apiBase: 'https://api.example.org/v1/',
        pathname: VERIFY,
      }),
    )
    expect(verify.get('connect-src')).toEqual(["'self'", 'https://api.example.org', 'https:'])
  })

  it('is one header line with no empty directive', () => {
    expect(policy).not.toMatch(/[\r\n]/)
    for (const [name, values] of d) {
      expect(name).toMatch(/^[a-z-]+$/)
      expect(values.length, name).toBeGreaterThan(0)
    }
  })
})

describe('isVerifyPage', () => {
  it('is true for /verify/<market>, the one page that reads the chain from the browser', () => {
    for (const path of [VERIFY, '/verify/abc', '/verify/abc/']) {
      expect(isVerifyPage(path), path).toBe(true)
    }
  })

  it('is false for every other path', () => {
    for (const path of [
      '/',
      '/game/x',
      '/game/verify',
      '/me',
      '/agent',
      '/verify',
      '/verify/',
      '/verifyx',
      '/verifyx/abc',
      '/verify/abc/more',
      '/x/verify/abc',
      '/VERIFY/abc',
    ]) {
      expect(isVerifyPage(path), path).toBe(false)
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

  it('widens connect-src to https: for a /verify page and no other', () => {
    const connect = (path: string) =>
      directives(
        proxy(new NextRequest(`http://localhost:3000${path}`)).headers.get(
          'content-security-policy',
        ) ?? '',
      ).get('connect-src')
    expect(connect(VERIFY)).toContain('https:')
    expect(connect(`${VERIFY}?rpc=x`)).toContain('https:')
    for (const path of ['/', '/game/x', '/me', '/verifyx', '/verify']) {
      expect(connect(path), path).not.toContain('https:')
    }
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

// Code that can run in the browser: everything under app/, components/ and lib/ except server
// code (lib/server, route handlers, image routes). The API client is lib/api.ts.
const browserFiles = (() => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(name)) files.push(p)
    }
  }
  for (const dir of ['app', 'components', 'lib']) walk(join(WEB, dir))
  return files
    .map((f) => relative(WEB, f).replaceAll('\\', '/'))
    .filter(
      (r) =>
        !(
          r.startsWith('lib/server/') ||
          /\/route\.tsx?$/.test(r) ||
          /(opengraph|twitter|apple)-image\.tsx$/.test(r)
        ),
    )
})()

/** A file's code with its comments taken out. */
const code = (file: string) =>
  readFileSync(join(WEB, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

// `fetch` as a value: a call, or handed to another function. `typeof fetch` is a type only.
const FETCH = /(?<!typeof\s+)\bfetch\b/g

/**
 * The browser code allowed to reach a host other than the API, each by file, pattern and exact
 * count: a new call anywhere else, or one more in this file, fails. Only /verify/<market> pages
 * load it, and only they widen connect-src to https: (isVerifyPage, docs/security.md).
 */
const ALLOWED_NETWORK = [
  {
    file: 'components/verify-view.tsx',
    pattern: FETCH,
    count: 2,
    reason:
      'the /verify checks run in the viewer browser, not on Horagon: fetchBytes reads the ' +
      'evidence from the URI stored on chain (then the API copy), and rpcAccount is handed ' +
      'fetch to read the GameMarket and Config accounts from the RPC the viewer picks',
  },
]

describe('the browser reaches only the API base', () => {
  const browser = browserFiles

  it('has no network call of its own (fetch, sockets, beacons, RPC connections)', () => {
    expect(browser.length).toBeGreaterThan(20)
    for (const f of browser) {
      const src = code(f)
      for (const pattern of [
        FETCH,
        /new Connection\(/g,
        /WebSocket/g,
        /EventSource/g,
        /XMLHttpRequest/g,
        /sendBeacon/g,
      ]) {
        const allowed = ALLOWED_NETWORK.find((a) => a.file === f && a.pattern === pattern)
        expect(src.match(pattern)?.length ?? 0, `${f} ${pattern}`).toBe(allowed?.count ?? 0)
      }
    }
  })

  it('allows only files that exist, each with a reason, each loaded by /verify alone', () => {
    for (const a of ALLOWED_NETWORK) {
      expect(browser, a.file).toContain(a.file)
      expect(a.reason.length, a.file).toBeGreaterThan(40)
      const name = a.file.replace(/^.*\//, '').replace(/\.tsx?$/, '')
      const importers = browser.filter((f) => new RegExp(`from '[^']*/${name}'`).test(code(f)))
      expect(importers, a.file).toEqual(['app/verify/[market]/page.tsx'])
      // The page that loads it is one the policy widens for.
      for (const page of importers) {
        const route = page.replace(/^app/, '').replace(/\/page\.tsx$/, '')
        expect(isVerifyPage(route.replace(/\[[^\]]+\]/g, 'x')), route).toBe(true)
      }
    }
  })
})

describe('links into /verify load a new document', () => {
  // A page's policy is fixed when its document loads. A client-side (next/link, router) move
  // into /verify would keep the previous page's connect-src and refuse the RPC; a plain <a> loads
  // the page, and with it the /verify policy.
  it('reaches /verify/<market> only through a plain <a href>', () => {
    let links = 0
    for (const f of browserFiles) {
      const src = code(f)
      for (const m of src.matchAll(/[`'"]\/verify\//g)) {
        const before = src.slice(Math.max(0, (m.index ?? 0) - 12), m.index)
        expect(before, `${f}: ${src.slice(m.index, (m.index ?? 0) + 40)}`).toMatch(/<a\s+href=\{?$/)
        links++
      }
      expect(src, f).not.toMatch(/(push|replace|prefetch|redirect)\(\s*[`'"]\/verify/)
    }
    expect(links).toBeGreaterThan(0)
  })

  it('the resolution card links /verify with an <a>, not next/link', () => {
    const card = code('components/chrono/resolution-card.tsx')
    expect(card).toMatch(/<a href=\{`\/verify\/\$\{r\.market\}`\}/)
  })
})
