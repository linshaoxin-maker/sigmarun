export function validPayload(): Record<string, unknown> {
  return {
    schema_version: 'team.plan_payload.v1',
    source: { tool: 'claude-code', command: '/team-plan', prompt: 'implement auth phase 1', agent_id: 'AGENT-claude-001' },
    run: { title: 'Implement auth phase 1', mode: 'feature', goal: 'Add the first auth slice.' },
    plan: { summary: 'Domain model first, then API tests.' },
    tasks: [
      {
        client_task_key: 'auth-domain',
        title: 'Add auth domain model',
        type: 'implementation',
        objective: 'Create domain types for auth users and sessions.',
        acceptance: ['AuthUser and Session types exist.'],
        paths: { allow: ['src/auth/**'] },
        required_checks: ['npm test -- auth'],
      },
      {
        client_task_key: 'auth-api-tests',
        title: 'Add auth API tests',
        type: 'implementation',
        objective: 'Add API-level tests for login.',
        acceptance: ['API tests cover successful login.'],
        depends_on: ['auth-domain'],
        paths: { allow: ['tests/auth/**'] },
      },
    ],
  };
}
