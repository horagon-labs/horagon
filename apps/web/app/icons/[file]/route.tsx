// The manifest's PNG icons (R5 review finding 12): the dial mark at 192 and 512 px, drawn by
// next/og once at build time (lib/icons.ts names the files).
import { ImageResponse } from 'next/og'
import { HomeIcon } from '../../../components/chrono/dial-mark'
import { ICON_COLORS, ICON_SIZES, iconFile, iconSize } from '../../../lib/icons'

export const dynamic = 'force-static'
export const dynamicParams = false

export function generateStaticParams(): { file: string }[] {
  return ICON_SIZES.map((px) => ({ file: iconFile(px) }))
}

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const px = iconSize((await ctx.params).file)
  if (px === null) return new Response('Not found', { status: 404 })
  return new ImageResponse(<HomeIcon px={px} colors={ICON_COLORS} />, { width: px, height: px })
}
