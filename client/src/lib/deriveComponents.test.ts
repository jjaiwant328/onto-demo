// Curated-measures sourcing in deriveComponents: bundled copy vs the runtime
// GET /api/measures refresh. Module state caches the refresh, so each case gets
// a fresh module instance (vi.resetModules) with its own fetch stub.
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Schema } from './deriveComponents';

async function freshModule(): Promise<typeof import('./deriveComponents')> {
  vi.resetModules();
  return import('./deriveComponents');
}

function schemaWith(...cols: string[]): Schema {
  return { 'db.fact_t': cols.map((name) => ({ name, type: 'double' })) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('curated measures source (bundled vs /api/measures)', () => {
  it('uses the server list when the fetch resolves', async () => {
    const serverMeasures = {
      measures: [
        {
          measure: 'server_kpi',
          type: 'derived',
          unit: 'ratio',
          formula: 'sum(sales) / sum(visits)',
          description: 'served from semantic_measures.yaml at runtime',
          depends_on: ['sales', 'visits'],
        },
      ],
    };
    const fetchMock = (): Promise<{ json: () => Promise<typeof serverMeasures> }> =>
      Promise.resolve({ json: () => Promise.resolve(serverMeasures) });
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();
    await mod.refreshCuratedMeasures();

    // the server entry applies when its formula's columns exist in the schema
    expect(mod.curatedMeasureFor('server_kpi', schemaWith('sales', 'visits'))).toEqual({
      formula: 'sum(sales) / sum(visits)',
      unit: 'ratio',
      description: 'served from semantic_measures.yaml at runtime',
    });
    // a non-empty server list REPLACES the bundled one (identical list ⇒
    // identical behavior): bundled-only names no longer apply
    expect(mod.curatedMeasureFor('total_customers', schemaWith('cust_id', 'txn_key'))).toBeNull();
  });

  it('falls back to the bundled copy when the fetch rejects', async () => {
    const fetchMock = (): Promise<never> => Promise.reject(new Error('companion app down'));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();
    await mod.refreshCuratedMeasures();

    // bundled measure still applies when its formula's columns exist in the schema
    expect(mod.curatedMeasureFor('total_customers', schemaWith('cust_id', 'txn_key'))).toEqual({
      formula: 'count(distinct coalesce(cust_id, txn_key))',
      unit: 'customers',
      description:
        'Distinct customer visits at a store on a day. Uses cust_id when present, else distinct transaction key (anonymous visits).',
    });
    // and nothing from a server ever landed
    expect(mod.curatedMeasureFor('server_kpi', schemaWith('sales', 'visits'))).toBeNull();
  });
});
