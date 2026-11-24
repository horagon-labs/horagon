// The Chronometer palette (spec 2.1), mirrored from the @theme block of app/globals.css so a
// Node test can check the contrast of every text pair (spec 6.2). Change both together.
export const COLORS = {
  'enamel-950': '#07090b',
  'enamel-900': '#0d1014',
  'enamel-800': '#11151a',
  line: '#2a2f35',
  'brass-700': '#7a6438',
  'brass-500': '#c8a46a',
  'brass-400': '#e9cf98',
  'lume-300': '#d9f99d',
  'ivory-100': '#efe6d2',
  'ash-400': '#8b8577',
  'amber-400': '#fbbf24',
  'red-400': '#f87171',
} as const

export type ColorToken = keyof typeof COLORS

/** WCAG 2.x relative luminance of a `#rrggbb` color. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`not a #rrggbb color: ${hex}`)
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = Number.parseInt(h ?? '0', 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two colors, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
