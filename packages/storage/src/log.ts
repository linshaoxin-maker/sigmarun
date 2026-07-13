/**
 * Opt-in step tracing (roadmap Phase 1 observability). When a transaction fails, the final envelope
 * is all the user sees — there is no record of the locks it took, the files it wrote, or the events
 * it appended. `--verbose` turns that on. Traces go to STDERR ONLY, never stdout: the machine face
 * (especially the single-line --json envelope) must stay uncontaminated.
 *
 * Instrumentation lives at the mutation choke points (lock, atomic write, event append), so the
 * whole gateway gains a trace without a logger threaded through every primitive.
 */
let verbose = false;

export function setVerbose(on: boolean): void {
  verbose = on;
}

export function isVerbose(): boolean {
  return verbose;
}

/** Shorten an absolute state path to its tail under .team/ for a readable trace. */
export function shortPath(file: string): string {
  const marker = `${'.team'}/`;
  const idx = file.lastIndexOf(marker);
  if (idx >= 0) return file.slice(idx + marker.length);
  const parts = file.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

/** Emit one trace line to stderr when --verbose is on. `area` is a short tag (lock/write/event/…). */
export function vlog(area: string, message: string): void {
  if (!verbose) return;
  process.stderr.write(`[sigmarun:${area}] ${message}\n`);
}
