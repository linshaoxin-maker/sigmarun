export { GatewayError, resolveTeamRoot, readJsonState, writeJsonStateAtomic, writeJsonStateNew, probeLockCapability } from '@sigmarun/storage';
export type { ReasonCode, TeamRootResolution, ResolveOptions } from '@sigmarun/storage';
export { okEnvelope, failEnvelope, GATEWAY_VERSION, ENVELOPE_VERSION } from './envelope.js';
export type { Envelope, EnvelopeMeta, EnvelopeWarning } from './envelope.js';
export { ProjectSchema, CountersSchema, parseSchemaId, SUPPORTED_MAJOR } from './schemas.js';
export { initProject, doctorProject } from './lifecycle.js';
export type { DoctorCheck } from './lifecycle.js';
