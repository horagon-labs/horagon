// Horagon's build config for the vendored SDK (replaces upstream's tsup.config.ts).
// dependencies are external automatically; the IDL JSON is bundled.
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', math: 'src/math.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
})
