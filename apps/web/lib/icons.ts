// The manifest's PNG icons (R5 review finding 12): the sizes Android's install prompt asks for,
// drawn from the dial mark by app/icons/[file]/route.tsx at build time.
import { COLORS } from './chrono/tokens'

export const ICON_SIZES = [192, 512] as const
export type IconSize = (typeof ICON_SIZES)[number]

/** "icon-192.png". */
export const iconFile = (px: IconSize): string => `icon-${px}.png`

/** The path the manifest lists: "/icons/icon-192.png". */
export const iconPath = (px: IconSize): string => `/icons/${iconFile(px)}`

/** The size a file name stands for, or null for any other name (a 404). */
export function iconSize(file: string): IconSize | null {
  return ICON_SIZES.find((px) => iconFile(px) === file) ?? null
}

/**
 * The dial mark's colours (light branding review §4.10), as app/icon.svg: a white face, the brass
 * case, a live needle and an ink hub. The wordmark and the share card draw it so.
 */
export const MARK_COLORS = {
  face: COLORS['enamel-900'],
  ring: COLORS['brass-700'],
  needle: COLORS.live,
  hub: COLORS['ivory-100'],
}

/** The mark of a page with nothing open on it (404, error): the needle stopped, in ink-muted. */
export const STOPPED_MARK = { ...MARK_COLORS, needle: COLORS['ash-400'] }

/** The brand palette of every home-screen icon: the mark on the paper. */
export const ICON_COLORS = { bg: COLORS['enamel-950'], ...MARK_COLORS }
