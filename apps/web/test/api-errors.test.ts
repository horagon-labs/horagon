// An API error's `type` (packages/api/src/problem.ts) is a URL on this site: /docs/errors#<code>.
// The site has no docs page of its own, so next.config.ts sends that path to the README's table.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import config, { API_ERRORS_DOC } from '../next.config'

const PROBLEM_TS = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'api',
  'src',
  'problem.ts',
)

describe('/docs/errors: where an API error type leads', () => {
  it('redirects the path of every problem type to the README table of codes', async () => {
    expect(readFileSync(PROBLEM_TS, 'utf8')).toContain(
      "export const PROBLEM_TYPE_BASE = 'https://www.horagon.xyz/docs/errors'\n",
    )
    expect(await config.redirects?.()).toEqual([
      { source: '/docs/errors', destination: API_ERRORS_DOC, permanent: false },
    ])
    expect(API_ERRORS_DOC).toBe(
      'https://github.com/horagon-labs/horagon/blob/main/README.md#api-errors',
    )
  })
})
