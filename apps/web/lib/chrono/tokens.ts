// The Chronometer palette (spec 2.1), light only (light branding review §3.3), mirrored from the
// @theme block of app/globals.css so a Node test can check the contrast of every pair (spec 6.2).
// Change both together. The old names keep their utilities and take the value of their role.
export const COLORS = {
  'enamel-950': '#f7f6f2', // surface
  'enamel-900': '#ffffff', // surface-raised
  'enamel-800': '#eeece6', // surface-sunk
  line: '#84817a', // rule
  'brass-700': '#8c7650', // brass
  'brass-500': '#17191d', // ink
  'brass-400': '#17191d', // ink
  'lume-300': '#17191d', // ink
  'ivory-100': '#17191d', // ink
  'ash-400': '#58585a', // ink-muted
  'amber-400': '#17191d', // ink
  'red-400': '#b3261e', // error
  live: '#0b5fa5', // the market is open, and your ◆
  'rule-faint': '#dad7cf', // structure that carries no data
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
