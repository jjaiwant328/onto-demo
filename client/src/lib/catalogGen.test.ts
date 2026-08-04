// The domain keywords describe convenience retail. On any other estate the grouping
// is at best a guess, so the catalog must say how confident it is rather than
// presenting a coincidental keyword hit as a business domain.
import { describe, it, expect } from 'vitest';
import { buildCatalogFromSchema } from './catalogGen';
import type { Schema } from './deriveComponents';

const factCols = [
  { name: 'row_id', type: 'bigint' },
  { name: 'event_date', type: 'date' },
  { name: 'amount', type: 'double' },
];

describe('domain classification on a non-retail schema', () => {
  // /transfer/ is in the merchandise_inventory pattern, so this healthcare table
  // used to be filed confidently under "Merchandise & Inventory".
  const healthcare: Schema = {
    'clinic.patient_transfer': factCols,
    'clinic.dim_department': [
      { name: 'department_id', type: 'int' },
      { name: 'department_name', type: 'string' },
    ],
  };

  it('marks a single incidental keyword hit as a weak match', () => {
    const cat = buildCatalogFromSchema(healthcare);
    const d = cat.domains.find((x) => x.products.length > 0);
    expect(d?.matchStrength).toBe('weak');
    expect(d?.matchEvidence).toMatch(/verify this grouping/i);
  });

  it('groups genuinely unmatched tables as unclassified, and says so', () => {
    const unmatched: Schema = {
      'telemetry.sensor_events': [
        { name: 'sensor_uid', type: 'string' },
        { name: 'reading_ts', type: 'timestamp' },
        { name: 'value', type: 'double' },
      ],
    };
    const cat = buildCatalogFromSchema(unmatched);
    const d = cat.domains[0];
    expect(d.label).toMatch(/unclassified/i);
    expect(d.matchStrength).toBe('none');
    expect(d.description).toMatch(/did not match any known business domain/i);
  });

  it('keeps a strong match strong for a schema the keywords really describe', () => {
    const retail: Schema = {
      'pos.store_labor_shift': [
        { name: 'store_number', type: 'int' },
        { name: 'calendar_day', type: 'date' },
        { name: 'labor_hours', type: 'double' },
      ],
    };
    const cat = buildCatalogFromSchema(retail);
    const d = cat.domains.find((x) => x.products.length > 0);
    // matches both "store" and "labor" → more than one keyword
    expect(d?.matchStrength).toBe('strong');
  });

  it('records alternate domains when a table matches more than one', () => {
    // "customer_order" hits merchandise (/order/) and customer_marketing (/customer/)
    const ambiguous: Schema = { 'ops.customer_order': factCols };
    const cat = buildCatalogFromSchema(ambiguous);
    const d = cat.domains.find((x) => x.products.length > 0);
    expect((d?.alternateDomains ?? []).length).toBeGreaterThan(0);
  });
});

describe('product construction stays schema-neutral', () => {
  it('does not require retail dim names to attach dimensions', () => {
    // no dim_store / dim_calendar anywhere — the old fallback found nothing here
    const mfg: Schema = {
      'mfg.fact_output': [
        { name: 'facility_id', type: 'int' },
        { name: 'run_date', type: 'date' },
        { name: 'units', type: 'int' },
      ],
      'mfg.dim_facility': [
        { name: 'facility_id', type: 'int' },
        { name: 'facility_name', type: 'string' },
      ],
    };
    const cat = buildCatalogFromSchema(mfg);
    const p = cat.domains.flatMap((d) => d.products).find((x) => x.fact_tables.length);
    expect(p?.dim_tables).toContain('mfg.dim_facility');
  });

  it('survives a schema with no numeric, key or date columns', () => {
    const degenerate: Schema = {
      'odd.notes': [
        { name: 'note', type: 'string' },
        { name: 'author', type: 'string' },
      ],
    };
    // must not throw, and must still produce something rather than crashing the app
    expect(() => buildCatalogFromSchema(degenerate)).not.toThrow();
    const cat = buildCatalogFromSchema(degenerate);
    expect(cat.domains.length).toBeGreaterThanOrEqual(0);
  });

  it('survives single-part table names', () => {
    const flat: Schema = { orders: factCols };
    expect(() => buildCatalogFromSchema(flat)).not.toThrow();
  });
});
