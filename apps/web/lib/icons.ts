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

/** The brand palette of every home-screen icon: enamel, its face, the brass bezel, a lume needle. */
export const ICON_COLORS = {
  bg: COLORS['enamel-950'],
  face: COLORS['enamel-800'],
  ring: COLORS['brass-500'],
  needle: COLORS['lume-300'],
}
