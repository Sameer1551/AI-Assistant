/**
 * Shared test helpers for the May platform.
 */

/**
 * Creates a minimal test RequestContext for use in unit and property tests.
 * Fields can be overridden by passing partial values.
 */
export function createTestContext(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    tenant_id: 'test-tenant-00000000-0000-0000-0000-000000000001',
    principal_id: 'test-principal-00000000-0000-0000-0000-000000000001',
    correlation_id: 'test-correlation-00000000-0000-0000-0000-000000000001',
    session_id: 'test-session-00000000-0000-0000-0000-000000000001',
    roles: ['End_User'],
    attributes: {},
    residency_region: 'us-east-1',
    ...overrides,
  };
}
