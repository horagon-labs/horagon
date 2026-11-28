import type { NextConfig } from 'next'

/** The README's API errors table on the public repository. */
export const API_ERRORS_DOC =
  'https://github.com/horagon-labs/horagon/blob/main/README.md#api-errors'

const config: NextConfig = {
  // Workspace packages ship TypeScript sources (api, db) or ESM (sdk); Next compiles them.
  transpilePackages: ['@horagon/sdk', '@horagon/api', '@horagon/db'],
  // Server-only dependencies with native or dynamic requires stay outside the bundle.
  serverExternalPackages: ['pino', 'postgres', '@electric-sql/pglite'],
  poweredByHeader: false,
  // The cluster name (not a secret) reaches the browser, so explorer links match the cluster.
  env: { NEXT_PUBLIC_HORAGON_CLUSTER: process.env.HORAGON_CLUSTER ?? 'devnet' },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ]
  },
  // An API error's `type` (packages/api/src/problem.ts) is /docs/errors#<code> on this origin:
  // the README's table of codes is the documentation, so the path sends a reader there.
  async redirects() {
    return [{ source: '/docs/errors', destination: API_ERRORS_DOC, permanent: false }]
  },
}

export default config
