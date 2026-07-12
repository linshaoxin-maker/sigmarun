import { describe, it, expect } from 'vitest';
import { scanForSecrets, redactText, readJsonState, GatewayError } from '@sigmarun/storage';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('OSS security review: redaction coverage gaps closed', () => {
  it('catches AWS secret access keys, DSA private keys, and password-only URLs (export leans on this)', () => {
    const cases = [
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
      'aws_secret_access_key: wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
      '-----BEGIN DSA PRIVATE KEY-----',
      'redis://:superSecretPass@10.0.0.1:6379',
    ];
    for (const c of cases) {
      expect(scanForSecrets(c).length, c).toBeGreaterThan(0);
      expect(redactText(c).text, c).toContain('[REDACTED:');
    }
  });

  it('still catches the previously-covered secrets (no regression)', () => {
    for (const c of ['AKIAIOSFODNN7EXAMPLE', 'ghp_' + 'a'.repeat(36), 'postgres://admin:hunter2@db:5432/x', 'password=hunter2']) {
      expect(scanForSecrets(c).length, c).toBeGreaterThan(0);
    }
  });
});

describe('OSS robustness review: malformed state is a clean error, not a crash', () => {
  it('readJsonState turns merge-conflict / invalid JSON into a GatewayError (not a raw SyntaxError)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-corrupt-'));
    const file = join(dir, 'run.json');
    writeFileSync(file, '<<<<<<< HEAD\n{"rev":1}\n=======\n{"rev":2}\n>>>>>>> branch\n');
    let caught: unknown;
    try { readJsonState(file); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).code).toBe('io_error');
    expect((caught as GatewayError).message).toMatch(/not valid JSON/);
  });
});
