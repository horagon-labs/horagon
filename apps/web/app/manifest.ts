// The web app manifest (R5): name, colors and icons for a phone's home screen, with the 192 and
// 512 px PNGs an install prompt prefers (app/icons/[file]/route.tsx).
import type { MetadataRoute } from 'next'
import { COLORS } from '../lib/chrono/tokens'
import { ICON_SIZES, iconPath } from '../lib/icons'
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE } from '../lib/meta'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_TITLE,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: '/',
    display: 'standalone',
    background_color: COLORS['enamel-950'],
    theme_color: COLORS['enamel-900'],
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
      ...ICON_SIZES.map((px) => ({ src: iconPath(px), sizes: `${px}x${px}`, type: 'image/png' })),
    ],
  }
}
