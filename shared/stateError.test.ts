// These messages are what a user sees when their generated work fails to save, so
// each branch is pinned against the ACTUAL driver strings observed in the field.
import { describe, it, expect } from 'vitest';
import { humanizeStateError } from './stateError';

describe('humanizeStateError', () => {
  it('explains a deleted Lakebase endpoint without leaking the driver payload', () => {
    // verbatim from @databricks/lakebase when the configured instance is gone
    const err = new Error(
      'Response from server (Not Found) {"error_code":"NOT_FOUND","message":"Endpoint ' +
        "'projects/jai-onto-demo/branches/production/endpoints/primary' not found\",\"details\":[]}"
    );
    const out = humanizeStateError(err);
    expect(out).toMatch(/no longer exists/i);
    // must not surface JSON, error codes or internal identifiers
    expect(out).not.toMatch(/NOT_FOUND|error_code|projects\/|\{/);
  });

  it('distinguishes "not configured" (local dev) from "not reachable"', () => {
    const out = humanizeStateError(
      'LAKEBASE_ENDPOINT or config.endpoint (or provide config.password for native auth) environment variable is required'
    );
    expect(out).toMatch(/not configured in this environment/i);
    expect(out).not.toMatch(/no longer exists/i);
  });

  it('reports a permissions failure as such', () => {
    expect(humanizeStateError(new Error('permission denied for table jai_domain_analysis'))).toMatch(
      /lacks permission/i
    );
  });

  it('reports a missing table as needing re-initialisation', () => {
    expect(
      humanizeStateError(new Error('relation "jai_domain_analysis" does not exist'))
    ).toMatch(/missing a table/i);
  });

  it('reports connection failures as a timeout rather than a rejection', () => {
    expect(humanizeStateError(new Error('connect ECONNREFUSED 10.0.0.1:5432'))).toMatch(
      /did not respond/i
    );
    expect(humanizeStateError(new Error('Connection terminated unexpectedly'))).toMatch(
      /did not respond/i
    );
  });

  it('falls back to a plain statement rather than an empty or raw message', () => {
    const out = humanizeStateError(new Error('some totally novel driver failure 12345'));
    expect(out).toMatch(/rejected the write/i);
    expect(out).not.toContain('12345');
  });

  it('handles non-Error values without throwing', () => {
    expect(() => humanizeStateError(undefined)).not.toThrow();
    expect(() => humanizeStateError({ weird: true })).not.toThrow();
    expect(humanizeStateError(undefined)).toBeTruthy();
  });

  it('never returns a message containing a stack trace or SQL', () => {
    const err = new Error('INSERT INTO jai_domain_analysis ... failed at line 42\n    at Pool.query');
    const out = humanizeStateError(err);
    expect(out).not.toMatch(/INSERT INTO|at Pool\.query/);
  });
});
