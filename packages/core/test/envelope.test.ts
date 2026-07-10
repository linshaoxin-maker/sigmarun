import { describe, it, expect } from 'vitest';
import { okEnvelope, failEnvelope } from '@sigmarun/core';

describe('envelope contract (docs/17 §2, D16 english machine face)', () => {
  it('ok envelope carries the seven contract fields with code OK', () => {
    const env = okEnvelope({ message: 'Initialized.', data: { a: 1 } });
    expect(Object.keys(env).sort()).toEqual(
      ['code', 'data', 'message', 'meta', 'next_actions', 'ok', 'warnings'].sort(),
    );
    expect(env.ok).toBe(true);
    expect(env.code).toBe('OK');
    expect(env.meta.envelope_version).toBe('team.envelope.v1');
    expect(env.meta.gateway_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('NFR-009: every failure envelope carries at least one next action', () => {
    const env = failEnvelope('not_a_git_repo', 'Current directory is not inside a git repository.');
    expect(env.ok).toBe(false);
    expect(env.code).toBe('not_a_git_repo');
    expect(env.next_actions.length).toBeGreaterThan(0);
  });

  it('D16: machine-face message contains no CJK characters', () => {
    const env = failEnvelope('not_a_git_repo', 'Current directory is not inside a git repository.');
    expect(env.message).not.toMatch(/[一-鿿]/);
    for (const a of env.next_actions) expect(a).not.toMatch(/[一-鿿]/);
  });
});
