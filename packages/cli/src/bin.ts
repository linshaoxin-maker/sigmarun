#!/usr/bin/env node
import { runCli } from './cli.js';

const result = runCli(process.argv.slice(2));
console.log(result.stdout);
process.exit(result.exitCode);
