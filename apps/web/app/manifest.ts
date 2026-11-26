// The web app manifest (R5): name, colors and icons for a phone's home screen.
import type { MetadataRoute } from 'next'
import { COLORS } from '../lib/chrono/tokens'
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE } from '../lib/meta'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_TITLE,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: '/',
    display: 'standalone',
    background_color: COLORS['enamel-950'],
    theme_color: COLORS['enamel-950'],
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  }
}
