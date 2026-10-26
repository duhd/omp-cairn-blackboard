/**
 * Best-effort, regex-only redaction of credential-shaped values.
 *
 * Shared by the fact board (nothing credential-like is persisted) and the optional
 * `redact-output` feature (tool results are rewritten before they enter the transcript).
 * It catches common shapes, not arbitrary secrets.
 *
 * Every pass must stay linear: redaction runs synchronously on every board write and on bash/eval
 * output, so a pathological line (a long run of dashes, thousands of unterminated PEM headers) would
 * otherwise freeze the omp process.
 */
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]{0,40}PRIVATE KEY-----/g;

/**
 * Replaces each BEGIN…END private key block, pairing a BEGIN with the first END after it (as a lazy
 * regex would). A lazy regex rescans to the end of the input from every unterminated BEGIN, which is
 * quadratic; here, a BEGIN with no END after it means no later BEGIN has one either, so the scan stops.
 */
function redactPrivateKeys(text: string): string {
  let out = "";
  let from = 0;
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(text); begin; begin = PEM_BEGIN.exec(text)) {
    PEM_END.lastIndex = PEM_BEGIN.lastIndex;
    if (!PEM_END.exec(text)) break;
    out += `${text.slice(from, begin.index)}[REDACTED PRIVATE KEY]`;
    from = PEM_END.lastIndex;
    PEM_BEGIN.lastIndex = from;
  }
  return out + text.slice(from);
}

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // key=value, key: value and "key": "value" for identifiers ending in a credential word
  // (password, client_secret, auth_token, AWS_SECRET_ACCESS_KEY, ...). `max_tokens` is not matched.
  // Token keys are handled by the next rule so the board's capability handles are never matched.
  // The key prefix is bounded: unbounded, every '-' in a long run starts a scan to the end of the run,
  // which made a single line of dashes quadratic (40 KB took seconds). The cost: a key whose part
  // before the credential word is longer than 64 characters with no '-' in it is no longer masked.
  [
    /\b([A-Za-z0-9_-]{0,64}(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key)["']?\s*[=:]\s*["']?)[^\s"']{8,}/gi,
    "$1[REDACTED]",
  ],
  // token-shaped assignments in any casing (auth_token, AUTH_TOKEN, accessToken, AccessToken, IdToken —
  // camelCase keys are real credentials in JSON from auth endpoints). The only exclusions are the board's
  // own capability handles (reason_token/lease_token and their camelCase source names), which a worker
  // must echo back verbatim and which are scoped, expiring and revocable.
  [
    /(?<![A-Za-z0-9_])(?!(?:reason_token|lease_token|reasonToken|leaseToken)\b)([A-Za-z0-9_-]{0,64}token["']?\s*[=:]\s*["']?)[^\s"']{8,}/gi,
    "$1[REDACTED]",
  ],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/g, "$1[REDACTED]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]"],
];

export function redactText(text: string): string {
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), redactPrivateKeys(text));
}
