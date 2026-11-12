// Tool output is stored for the dashboard, so obvious secrets are masked and long blobs clipped first.

const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key hidden]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g, '$1 [hidden]'],
  [/\b(sk|pk|rk|hb|ghp|gho|ghs|ghu|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/g, '[token hidden]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[token hidden]'],
  [/\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"']{6,}\3/gi, '$1$2$3[hidden]$3'],
]

export function redact(text: string): string {
  let out = text
  for (const [re, to] of RULES) out = out.replace(re, to)
  return out
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… ${text.length - max} more characters not shown`
}

export function oneLine(text: unknown, max: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/** Deep copy with every string redacted and clipped; used for tool inputs. */
export function scrub(value: unknown, max = 4000): unknown {
  if (typeof value === 'string') return clip(redact(value), max)
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, max))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, max)
    return out
  }
  return value
}
