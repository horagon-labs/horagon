// The home-screen icon (R5): the dial mark of app/icon.svg on the enamel, as a 180 px PNG.
import { ImageResponse } from 'next/og'
import { HomeIcon } from '../components/chrono/dial-mark'
import { ICON_COLORS } from '../lib/icons'

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(<HomeIcon px={size.width} colors={ICON_COLORS} />, size)
}
