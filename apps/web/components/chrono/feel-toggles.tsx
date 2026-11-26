'use client'
// The three feel switches in the wallet sheet (spec 2.5), saved by lib/chrono/feel.ts. Haptics
// shows only where navigator.vibrate exists; it is on by default there.
import { canVibrate, type Feel, useFeel } from '../../lib/chrono/feel'

const MOTION = { system: null, on: true, off: false } as const
type MotionChoice = keyof typeof MOTION

const choiceOf = (v: boolean | null): MotionChoice => (v === null ? 'system' : v ? 'on' : 'off')

export function FeelForm(p: { feel: Feel; onChange: (next: Feel) => void; vibrates: boolean }) {
  const { feel } = p
  const box = 'size-5 accent-ivory-100'
  const row = 'flex min-h-11 items-center justify-between gap-3 text-13 text-ivory-100'
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-13 font-semibold">Feel</legend>
      {p.vibrates && (
        <label className={row}>
          Haptics
          <input
            type="checkbox"
            checked={feel.haptics}
            onChange={(e) => p.onChange({ ...feel, haptics: e.target.checked })}
            className={box}
          />
        </label>
      )}
      <label className={row}>
        Tick sound
        <input
          type="checkbox"
          checked={feel.sound}
          onChange={(e) => p.onChange({ ...feel, sound: e.target.checked })}
          className={box}
        />
      </label>
      <label className={row}>
        Reduce motion
        <select
          value={choiceOf(feel.reducedMotion)}
          onChange={(e) =>
            p.onChange({ ...feel, reducedMotion: MOTION[e.target.value as MotionChoice] })
          }
          className="min-h-11 rounded-card border border-line bg-enamel-900 px-2"
        >
          <option value="system">Like this device</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </label>
    </fieldset>
  )
}

export function FeelToggles() {
  const [feel, setFeel] = useFeel()
  return <FeelForm feel={feel} onChange={setFeel} vibrates={canVibrate(globalThis.navigator)} />
}
