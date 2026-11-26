// Colour science for the token tests (light branding review §3.5): CIE Lab (D65), CIEDE2000, and
// the Machado, Oliveira and Fernandes (2009) colour-vision simulation at severity 1.0, applied in
// linear sRGB. Test-only: nothing here ships to the browser.

export type Vision = 'normal' | 'protan' | 'deutan' | 'tritan'
export const VISIONS: readonly Vision[] = ['normal', 'protan', 'deutan', 'tritan']

type Vec3 = [number, number, number]
type Mat3 = [Vec3, Vec3, Vec3]

const MACHADO: Record<Exclude<Vision, 'normal'>, Mat3> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
}

function linearRgb(hex: string): Vec3 {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`not a #rrggbb color: ${hex}`)
  return [m[1], m[2], m[3]].map((h) => {
    const c = Number.parseInt(h ?? '0', 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as Vec3
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** The color as seen with the given vision, in linear sRGB. */
export function simulate(hex: string, vision: Vision): Vec3 {
  const rgb = linearRgb(hex)
  if (vision === 'normal') return rgb
  return MACHADO[vision].map((row) =>
    clamp01(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]),
  ) as Vec3
}

/** CIE L*a*b* (D65) of a linear sRGB color. */
export function lab([r, g, b]: Vec3): Vec3 {
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
  const [fx, fy, fz] = [f(x), f(y), f(z)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIEDE2000 colour difference of two Lab colors (Sharma, Wu and Dalal 2005). */
export function deltaE2000([l1, a1, b1]: Vec3, [l2, a2, b2]: Vec3): number {
  const rad = Math.PI / 180
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)))
  const a1p = (1 + g) * a1
  const a2p = (1 + g) * a2
  const c1p = Math.hypot(a1p, b1)
  const c2p = Math.hypot(a2p, b2)
  const hue = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0
    const h = Math.atan2(b, a) / rad
    return h < 0 ? h + 360 : h
  }
  const h1p = hue(b1, a1p)
  const h2p = hue(b2, a2p)
  const dLp = l2 - l1
  const dCp = c2p - c1p
  let dhp = 0
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp / 2) * rad)
  const lBarP = (l1 + l2) / 2
  const cBarP = (c1p + c2p) / 2
  let hBarP = h1p + h2p
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hBarP /= 2
    else hBarP = h1p + h2p < 360 ? (hBarP + 360) / 2 : (hBarP - 360) / 2
  }
  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * rad) +
    0.24 * Math.cos(2 * hBarP * rad) +
    0.32 * Math.cos((3 * hBarP + 6) * rad) -
    0.2 * Math.cos((4 * hBarP - 63) * rad)
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2))
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7))
  const sl = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2)
  const sc = 1 + 0.045 * cBarP
  const sh = 1 + 0.015 * cBarP * t
  const rt = -Math.sin(2 * dTheta * rad) * rc
  return Math.sqrt(
    (dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh),
  )
}

/** CIEDE2000 between two `#rrggbb` colors as seen with the given vision. */
export function visionDelta(a: string, b: string, vision: Vision): number {
  return deltaE2000(lab(simulate(a, vision)), lab(simulate(b, vision)))
}

/** Alpha over a background, blended in gamma sRGB as browsers do. */
export function over(fg: string, alpha: number, bg: string): string {
  const ch = (hex: string, i: number) => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  return `#${[0, 1, 2]
    .map((i) => Math.round(ch(fg, i) * alpha + ch(bg, i) * (1 - alpha)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`
}
