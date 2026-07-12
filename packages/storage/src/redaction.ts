export interface SecretHit {
  kind: string;
}

/** Secret pattern set. @contract docs/24 §4.2 — best-effort regex tier; FEAT-007 upgrades this to a replacing pipeline. */
export const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'aws_key', re: /AKIA[0-9A-Z]{16}/ },
  { kind: 'aws_secret', re: /aws_secret_access_key\s*[=:]\s*\S+|AWS_SECRET_ACCESS_KEY\s*[=:]\s*\S+/i },
  { kind: 'private_key', re: /-----BEGIN (?:RSA|DSA|EC|OPENSSH|PGP) PRIVATE KEY-----/ },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { kind: 'npm_token', re: /npm_[A-Za-z0-9]{36}/ },
  { kind: 'generic_bearer', re: /[Bb]earer\s+[A-Za-z0-9._-]{16,}/ },
  { kind: 'env_assignment', re: /[A-Za-z0-9_]*(?:password|passwd|secret|token|api_?key|access_key)\s*[=:]\s*\S+/i },
  { kind: 'connection_string', re: /\w+:\/\/[^:\s]+:[^@\s]+@/ },
  { kind: 'connection_string_pw_only', re: /\w+:\/\/:[^@\s]+@/ },
];

export function scanForSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) hits.push({ kind: p.kind });
  return hits;
}

/** Replacing pipeline (docs/24 §4 / docs/14 §2.2): every match becomes `[REDACTED:kind]`. */
export function redactText(text: string): { text: string; hits: SecretHit[] } {
  let out = text;
  const hits: SecretHit[] = [];
  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    if (re.test(out)) {
      hits.push({ kind: p.kind });
      out = out.replace(re, `[REDACTED:${p.kind}]`);
    }
  }
  return { text: out, hits };
}
