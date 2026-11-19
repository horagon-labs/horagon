import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Committed spike evidence: one JSON file per run. */
export const RESULTS_DIR = join(import.meta.dirname, '../../results')

export interface SpikeCheck {
  name: string
  pass: boolean
  detail?: string
}

export interface SpikeResult {
  spike: string
  cluster: string
  startedAt: string
  finishedAt: string
  pass: boolean
  checks: SpikeCheck[]
  data: Record<string, unknown>
}

const jsonSafe = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value

/** Collects pass/fail checks and measurements, then writes `spikes/results/<spike>-<time>.json`. */
export class SpikeRun {
  readonly checks: SpikeCheck[] = []
  readonly data: Record<string, unknown> = {}
  private readonly startedAt = new Date().toISOString()

  constructor(
    readonly spike: string,
    readonly cluster: string,
  ) {}

  check(name: string, pass: boolean, detail?: string): boolean {
    this.checks.push(detail === undefined ? { name, pass } : { name, pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  (${detail})`}`)
    return pass
  }

  record(key: string, value: unknown): void {
    this.data[key] = value
    console.log(`      ${key}: ${JSON.stringify(value, jsonSafe)}`)
  }

  save(error?: unknown): SpikeResult {
    if (error !== undefined) {
      this.check('run completed without an exception', false, String(error))
      this.record('error', error instanceof Error ? (error.stack ?? error.message) : String(error))
    }
    const result: SpikeResult = {
      spike: this.spike,
      cluster: this.cluster,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      pass: this.checks.length > 0 && this.checks.every((c) => c.pass),
      checks: this.checks,
      data: this.data,
    }
    mkdirSync(RESULTS_DIR, { recursive: true })
    const file = join(RESULTS_DIR, `${this.spike}-${this.startedAt.replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, `${JSON.stringify(result, jsonSafe, 2)}\n`)
    console.log(`${result.pass ? 'SPIKE PASS' : 'SPIKE FAIL'}: ${file}`)
    return result
  }
}

/** Run a spike body, always save the result, and exit non-zero on failure. */
export async function runSpike(run: SpikeRun, body: () => Promise<void>): Promise<never> {
  let error: unknown
  try {
    await body()
  } catch (e) {
    error = e
  }
  const result = run.save(error)
  process.exit(result.pass ? 0 : 1)
}
