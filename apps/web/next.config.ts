import type { NextConfig } from 'next'

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
}

export default config
