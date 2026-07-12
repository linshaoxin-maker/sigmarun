#!/usr/bin/env node
import { runCli } from './cli.js';
import { GATEWAY_VERSION } from '@sigmarun/core';

// Last-resort guard: no gateway failure should ever reach the user as a raw
// stack trace. runCli is expected to return a clean envelope for every input;
// if something escapes it, still emit a single machine-parseable envelope and
// exit 1 (the "other failure" class, docs/17 §2.2) rather than crash.
try {
  const result = runCli(process.argv.slice(2));
  console.log(result.stdout);
  process.exit(result.exitCode);
} catch (err) {
  const json = process.argv.includes('--json');
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      code: 'internal_error',
      message,
      data: {},
      warnings: [],
      next_actions: ['This is a bug — please report it with the command you ran.'],
      meta: { gateway_version: GATEWAY_VERSION, envelope_version: 'team.envelope.v1', elapsed_ms: 0 },
    }));
  } else {
    console.error(`sigmarun: internal error: ${message}`);
    console.error('This is a bug — please report it with the command you ran.');
  }
  process.exit(1);
}
