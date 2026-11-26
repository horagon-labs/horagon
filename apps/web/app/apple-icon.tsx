// The home-screen icon (R5): the dial mark of app/icon.svg on the enamel, as a 180 px PNG.
import { ImageResponse } from 'next/og'
import { DialMark } from '../components/chrono/dial-mark'
import { COLORS } from '../lib/chrono/tokens'

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: COLORS['enamel-950'],
      }}
    >
      <DialMark
        size={148}
        face={COLORS['enamel-800']}
        ring={COLORS['brass-500']}
        needle={COLORS['lume-300']}
      />
    </div>,
    size,
  )
}
