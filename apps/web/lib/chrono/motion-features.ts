// The DOM animation features of motion (spec 2.4), in a chunk of their own: ChronoMotion loads them
// right after the first render, so they are not part of any page's first load (R5c refix). Nothing
// waits for them: the rolling digits start at their place (initial={false}), and the beats mount
// only for a change after the page load (spec 2.4), by which time the features are in.
export { domAnimation as default } from 'motion/react'
