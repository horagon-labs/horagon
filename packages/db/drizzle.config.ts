import { defineConfig } from 'drizzle-kit'

// Generates SQL migrations from src/schema.ts. Hand-written SQL (functions) goes in a
// `drizzle-kit generate --custom` migration so the journal keeps one order for both.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
})
