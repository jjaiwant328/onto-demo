// The derived contract is a governance document. Anything it asserts that the app
// has not verified is worse than silence, and the heuristics must behave sanely for
// a schema from ANY industry — not just the bundled convenience-retail demo.
import { describe, it, expect } from 'vitest';
import { deriveContract, piiCandidates, piiCandidatesForProduct } from './contract';
import { deriveProduct, type Schema, type CatalogProduct } from './deriveComponents';

function build(schema: Schema, kpis: string[], name = 'jai_fact') {
  const fact = Object.keys(schema)[0];
  const product: CatalogProduct = {
    product_name: name,
    display_name: 'P',
    business_outcome: '',
    fact_tables: [fact],
    dim_tables: Object.keys(schema).slice(1),
    kpis,
    maturity: 'incubating',
  };
  return deriveContract(product, deriveProduct(product, schema));
}

describe('parts_le_total must not invent constraints', () => {
  // manufacturing: total_scrap / scrap_parts are unrelated measures that both
  // happened to match the old retail vocabulary regex (`part`).
  it('does not assert parts<=total for unrelated same-word measures', () => {
    const c = build(
      {
        'mfg.fact_run': [
          { name: 'run_id', type: 'bigint' },
          { name: 'run_date', type: 'date' },
          { name: 'total_scrap', type: 'int' },
          { name: 'subassembly_count', type: 'int' },
        ],
      },
      ['total_scrap']
    );
    expect(c.quality_checks.find((q) => q.id === 'parts_le_total')).toBeUndefined();
  });

  // retail: total_customers / shop_customers share the "customers" stem, so the
  // relationship IS established by the names.
  it('still asserts parts<=total when names share the total stem', () => {
    const c = build(
      {
        'pos.fact_day': [
          { name: 'store_number', type: 'int' },
          { name: 'calendar_day', type: 'date' },
          { name: 'total_customers', type: 'bigint' },
          { name: 'shop_customers', type: 'bigint' },
        ],
      },
      ['total_customers']
    );
    const rule = c.quality_checks.find((q) => q.id === 'parts_le_total');
    expect(rule?.rule).toBe('shop_customers <= total_customers');
  });
});

describe('freshness basis must name a real column', () => {
  it('names an actual temporal column', () => {
    const c = build(
      {
        'iot.fact_reading': [
          { name: 'device_id', type: 'string' },
          { name: 'measurement_ts', type: 'timestamp' },
          { name: 'reading', type: 'double' },
        ],
      },
      ['reading']
    );
    expect(c.freshness.basis).toBe('measurement_ts');
  });

  it('admits it when the schema has no date/time column', () => {
    const c = build(
      {
        'ref.fact_batch': [
          { name: 'batch_id', type: 'string' },
          { name: 'qty', type: 'int' },
        ],
      },
      ['qty']
    );
    // must NOT name a phantom column such as "load timestamp"
    expect(c.freshness.basis).toMatch(/unknown/i);
  });
});

describe('PII claims must be checked, not assumed', () => {
  it('detects personal-data candidates by name across industries', () => {
    const found = piiCandidates([
      { name: 'patient_email', type: 'string', nullable: true, key: false },
      { name: 'home_address', type: 'string', nullable: true, key: false },
      { name: 'widget_count', type: 'int', nullable: false, key: false },
    ]);
    expect(found).toContain('patient_email');
    expect(found).toContain('home_address');
    expect(found).not.toContain('widget_count');
  });

  it('does not claim PII is excluded when personal data is present', () => {
    const c = build(
      {
        'hr.fact_visit': [
          { name: 'visit_id', type: 'bigint' },
          { name: 'visit_date', type: 'date' },
          { name: 'patient_email', type: 'string' },
          { name: 'duration_min', type: 'int' },
        ],
      },
      ['duration_min']
    );
    expect(c.scope.excluded).toMatch(/possible personal data/i);
    expect(c.scope.excluded).toContain('patient_email');
  });

  it('finds personal data on a joined dimension, not just the fact table', () => {
    const schema: Schema = {
      'hc.fact_encounter': [
        { name: 'encounter_id', type: 'bigint' },
        { name: 'patient_key', type: 'string' },
        { name: 'encounter_date', type: 'date' },
        { name: 'charges', type: 'double' },
      ],
      'hc.dim_patient': [
        { name: 'patient_key', type: 'string' },
        { name: 'patient_email', type: 'string' },
        { name: 'home_address', type: 'string' },
      ],
    };
    const product: CatalogProduct = {
      product_name: 'jai_fact_encounter',
      display_name: 'Encounters',
      business_outcome: '',
      fact_tables: ['hc.fact_encounter'],
      dim_tables: ['hc.dim_patient'],
      kpis: ['charges'],
      maturity: 'incubating',
    };
    const found = piiCandidatesForProduct(deriveProduct(product, schema));
    expect(found).toContain('dim_patient.patient_email');
    expect(found).toContain('dim_patient.home_address');
  });

  it('says so plainly when no personal data is detected', () => {
    const c = build(
      {
        'ops.fact_line': [
          { name: 'line_id', type: 'bigint' },
          { name: 'run_date', type: 'date' },
          { name: 'units', type: 'int' },
        ],
      },
      ['units']
    );
    expect(c.scope.excluded).toMatch(/no personal-data columns detected/i);
  });
});

describe('curated flagship contract must not leak to look-alike products', () => {
  it('does not return the retail contract for a same-named product on other tables', () => {
    const foreign: Schema = {
      'clinic.fact_visits': [
        { name: 'visit_id', type: 'bigint' },
        { name: 'visit_date', type: 'date' },
        { name: 'total_customers', type: 'int' },
      ],
    };
    const product: CatalogProduct = {
      product_name: 'jai_store_traffic_labor_efficiency', // same name as the flagship
      display_name: 'Visits',
      business_outcome: '',
      fact_tables: ['clinic.fact_visits'],
      dim_tables: [],
      kpis: ['total_customers'],
      maturity: 'ga',
      live: true,
    };
    const c = deriveContract(product, deriveProduct(product, foreign));
    // must not inherit the demo's lineage
    expect(c.lineage.sources.join(',')).not.toMatch(/fc_entdata_gold/);
    expect(c.serving_object).not.toMatch(/jai_ontos/);
  });
});
