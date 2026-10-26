/**
 * Best-effort, regex-only redaction of credential-shaped values.
 *
 * Shared by the fact board (nothing credential-like is persisted) and the optional
 * `redact-output` feature (tool results are rewritten before they enter the transcript).
 * It catches common shapes, not arbitrary secrets.
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private key blocks (multi-line, so they go first).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  // key=value, key: value and "key": "value" for identifiers ending in a credential word
  // (password, client_secret, auth_token, AWS_SECRET_ACCESS_KEY, ...). `max_tokens` is not matched.
  // Generic key=value credential assignments (no token; handled separately so the board's
  // capability handles are never matched).
  [
    /\b([A-Za-z0-9_-]*(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key)["']?\s*[=:]\s*["']?)[^\s"']{8,}/gi,
    "$1[REDACTED]",
  ],
  // token-shaped assignments in any casing (auth_token, AUTH_TOKEN, accessToken, AccessToken, IdToken —
  // camelCase keys are real credentials in JSON from auth endpoints). The only exclusions are the board's
  // own capability handles (reason_token/lease_token and their camelCase source names), which a worker
  // must echo back verbatim and which are scoped, expiring and revocable.
  [
    /(?<![A-Za-z0-9_])(?!(?:reason_token|lease_token|reasonToken|leaseToken)\b)([A-Za-z0-9_-]*token["']?\s*[=:]\s*["']?)[^\s"']{8,}/gi,
    "$1[REDACTED]",
  ],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/g, "$1[REDACTED]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]"],
];

export function redactText(text: string): string {
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
