import { HoragonError } from '../errors'

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function invalid(path: string, reason: string): HoragonError {
  return new HoragonError('INVALID_INPUT', `canonicalize: ${path}: ${reason}`)
}

function serializeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) throw invalid(path, 'string contains a lone surrogate')
  return JSON.stringify(value)
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return serializeString(value, path)
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw invalid(path, `only safe integers are allowed, got ${value}`)
      }
      return Object.is(value, -0) ? '0' : String(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${Array.from(value, (v, i) => serialize(v, `${path}[${i}]`)).join(',')}]`
      }
      const proto: unknown = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw invalid(path, 'only plain objects are allowed')
      }
      const record = value as Record<string, unknown>
      const members = Object.keys(record)
        .sort()
        .map((key) => `${serializeString(key, path)}:${serialize(record[key], `${path}.${key}`)}`)
      return `{${members.join(',')}}`
    }
    default:
      throw invalid(path, `unsupported type ${typeof value}`)
  }
}

/**
 * RFC 8785 (JCS) canonical JSON for the subset Horagon evidence uses: strings, safe
 * integers, booleans, null, arrays and plain objects. Floats are rejected so that any
 * language (the Python verifier included) reproduces the same bytes.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, '$')
}
