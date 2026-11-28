// The program ids a reader copies from the docs are the deployed ones: Horagon's from
// `declare_id!` in lib.rs, pm-AMM's from the IDL the program's CPI is built from. Any base58
// string in the README, docs/ or the site's sources that starts like one of them must be it
// (a one-character typo in README.md once named a program that does not exist).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PM_AMM_PROGRAM_ID } from '../../src/pm-amm/constants'
import { HORAGON_PROGRAM_ID } from '../../src/program/constants'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), 'utf8')

const declared = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(
  read('programs', 'horagon', 'src', 'lib.rs'),
)?.[1]
const pmAmm = (JSON.parse(read('idls', 'pm_amm.json')) as { address: string }).address

/** README.md, docs/*.md and the web app's sources, by path from the repository root. */
function texts(): Array<[string, string]> {
  const out: Array<[string, string]> = [['README.md', read('README.md')]]
  for (const f of readdirSync(join(ROOT, 'docs'))) {
    if (f.endsWith('.md')) out.push([`docs/${f}`, read('docs', f)])
  }
  for (const dir of ['app', 'components', 'lib']) {
    const files = readdirSync(join(ROOT, 'apps', 'web', dir), { recursive: true, encoding: 'utf8' })
    for (const f of files.filter((x) => /\.tsx?$/.test(x))) {
      out.push([`apps/web/${dir}/${f}`, read('apps', 'web', dir, f)])
    }
  }
  return out
}

describe('program ids in the docs and on the site', () => {
  it('reads the ids the SDK uses from the program and the IDL', () => {
    expect(declared).toBe('HtDJ3vfx8vtFSmskm2Ks39kBMuDmFZH3H2B173BB9qHF')
    expect(HORAGON_PROGRAM_ID.toBase58()).toBe(declared)
    expect(pmAmm).toBe('GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y')
    expect(PM_AMM_PROGRAM_ID.toBase58()).toBe(pmAmm)
  })

  it.each([
    ['horagon', 'HtDJ'],
    ['pm-AMM', 'GV1F'],
  ])('names only the deployed %s id wherever a full id starting %s appears', (_name, head) => {
    const id = head === 'HtDJ' ? declared : pmAmm
    const token = new RegExp(`\\b${head}[1-9A-HJ-NP-Za-km-z]{28,40}\\b`, 'g')
    const wrong = texts().flatMap(([path, text]) =>
      [...text.matchAll(token)].filter((m) => m[0] !== id).map((m) => `${path}: ${m[0]}`),
    )
    expect(wrong).toEqual([])
  })

  it('names the deployed program where the README says what runs on devnet', () => {
    expect(read('README.md')).toContain(`deployed on devnet: the program \`${declared}\``)
  })
})
