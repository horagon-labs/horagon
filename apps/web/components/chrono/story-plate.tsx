// The story plate on a stopped face (culture A2, R8): UPSET, COMEBACK or OVERTIME, one plate,
// in the same pill as the PRACTICE plate. The story is lib/chrono/story.ts's.
import type { Story } from '../../lib/chrono/story'
import { PLATE } from './practice-plate'

export function StoryPlate({ story }: { story: Story | null }) {
  if (!story) return null
  return (
    <span className={PLATE} data-story={story}>
      {story}
    </span>
  )
}
