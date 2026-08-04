// Guards on the derivation pipeline's honesty: a KPI or measure must never be
// presented as column-backed unless a real column backs it, and provenance must
// survive the derive step. These are the checks that stop the catalog from
// quietly asserting things about a customer's data that aren't true.
import { describe, it, expect } from 'vitest';
import { sanitizeCatalog } from './product';
import {
  deriveProduct,
  isCuratedMeasure,
  type Catalog,
  type Schema,
  type CatalogProduct,
} from './deriveComponents';

const schema: Schema = {
  'sales.fact_orders': [
    { name: 'order_id', type: 'bigint' },
    { name: 'store_number', type: 'int' },
    { name: 'calendar_day', type: 'date' },
    { name: 'net_sales', type: 'decimal(18,2)' },
    { name: 'units', type: 'int' },
  ],
  'sales.dim_store': [
    { name: 'store_number', type: 'int' },
    { name: 'store_name', type: 'string' },
  ],
};

const product: CatalogProduct = {
  product_name: 'jai_fact_orders',
  display_name: 'Orders',
  business_outcome: 'Analyze orders.',
  fact_tables: ['sales.fact_orders'],
  dim_tables: ['sales.dim_store'],
  kpis: ['net_sales', 'gross_margin_pct'], // second one has no backing column
  maturity: 'incubating',
};

const catalog: Catalog = {
  domains: [{ name: 'sales_pos', label: 'Sales & POS', description: '', products: [product] }],
};

describe('sanitizeCatalog — KPI verification', () => {
  it('flags KPI names with no matching column on the fact tables', () => {
    const out = sanitizeCatalog(catalog, schema, 'llm');
    const p = out.domains[0].products[0];
    expect(p.unverifiedKpis).toEqual(['gross_margin_pct']);
    // the real KPI is not flagged
    expect(p.unverifiedKpis).not.toContain('net_sales');
  });

  it('keeps every KPI (a composite may be legitimate) but orders verified first', () => {
    const out = sanitizeCatalog(catalog, schema, 'llm');
    const p = out.domains[0].products[0];
    expect(p.kpis).toHaveLength(2);
    expect(p.kpis[0]).toBe('net_sales');
  });

  it('records who authored the labels so the UI can badge them', () => {
    const out = sanitizeCatalog(catalog, schema, 'llm');
    expect(out.domains[0].labelOrigin).toBe('llm');
    expect(out.domains[0].products[0].labelOrigin).toBe('llm');
  });

  it('leaves provenance unset when no origin is supplied (heuristic path)', () => {
    const out = sanitizeCatalog(catalog, schema);
    expect(out.domains[0].products[0].labelOrigin).toBeUndefined();
  });

  it('still drops tables that are not in the schema', () => {
    const hallucinated: Catalog = {
      domains: [
        {
          name: 'sales_pos',
          label: 'Sales & POS',
          description: '',
          products: [{ ...product, dim_tables: ['sales.dim_store', 'sales.does_not_exist'] }],
        },
      ],
    };
    const out = sanitizeCatalog(hallucinated, schema, 'llm');
    expect(out.domains[0].products[0].dim_tables).toEqual(['sales.dim_store']);
  });

  it('sets no unverifiedKpis key when every KPI is column-backed', () => {
    const clean: Catalog = {
      domains: [
        {
          name: 'sales_pos',
          label: 'Sales & POS',
          description: '',
          products: [{ ...product, kpis: ['net_sales', 'units'] }],
        },
      ],
    };
    const out = sanitizeCatalog(clean, schema, 'llm');
    expect(out.domains[0].products[0].unverifiedKpis).toBeUndefined();
  });
});

describe('deriveProduct — measure provenance', () => {
  it('marks a column-backed measure observed with an additive formula', () => {
    const c = deriveProduct(product, schema);
    const m = c.measures.find((x) => x.measure === 'net_sales');
    expect(m?.origin).toBe('observed');
    expect(m?.unverified).toBeFalsy();
    expect(m?.formula).toBe('sum(net_sales)');
  });

  it('marks a KPI with no backing column unverified, without a confident formula', () => {
    const c = deriveProduct(product, schema);
    const m = c.measures.find((x) => x.measure === 'gross_margin_pct');
    expect(m?.unverified).toBe(true);
    expect(m?.unit).toBe('unverified');
    expect(m?.formula).toMatch(/definition required/);
    expect(m?.evidence).toMatch(/no column named/i);
  });

  it('attributes an unverified KPI to the model when the labels were AI-authored', () => {
    const c = deriveProduct({ ...product, labelOrigin: 'llm' }, schema);
    expect(c.measures.find((x) => x.measure === 'gross_margin_pct')?.origin).toBe('llm');
  });

  it('carries evidence on inferred column roles and FK relationships', () => {
    const c = deriveProduct(product, schema);
    // the shared-key FK is inferred, not declared — it must say so
    const rel = c.relationships.find((r) => r.predicate === 'store_number');
    expect(rel?.origin).toBe('heuristic');
    expect(rel?.evidence).toMatch(/inferred, not a declared constraint/);
    // a key column's role explains which rule fired
    const keyMap = c.mappings.find((m) => m.column === 'store_number');
    expect(keyMap?.role).toBe('key');
    expect(keyMap?.evidence).toBeTruthy();
  });

  it('treats classes as observed — the table really exists', () => {
    const c = deriveProduct(product, schema);
    expect(c.classes.every((k) => k.origin === 'observed')).toBe(true);
  });

  // A curated KPI is defined by a human in semantic_measures.yaml even though no
  // single column carries its name — reporting it as "definition required" would
  // be wrong in the opposite direction. But it may only be applied when the
  // formula's inputs actually exist here.
  it('honours a curated KPI when its formula inputs exist in the schema', () => {
    const retailish: Schema = {
      'ops.fact_store_day': [
        { name: 'store_number', type: 'int' },
        { name: 'calendar_day', type: 'date' },
        { name: 'total_customers', type: 'bigint' },
        { name: 'total_labor_cost', type: 'decimal(18,2)' },
      ],
    };
    expect(isCuratedMeasure('labor_cost_per_customer', retailish)).toBe(true);
    const c = deriveProduct(
      {
        ...product,
        fact_tables: ['ops.fact_store_day'],
        dim_tables: [],
        kpis: ['labor_cost_per_customer'],
      },
      retailish
    );
    const m = c.measures.find((x) => x.measure === 'labor_cost_per_customer');
    expect(m?.unverified).toBeFalsy();
    expect(m?.origin).toBe('user');
    expect(m?.formula).toContain('total_labor_cost');
  });
});

// The bundled curated formulas describe ONE retail product. Leaking them onto a
// look-alike column in an uploaded schema would badge fabricated logic with the
// app's strongest trust signal, referencing columns that schema doesn't have.
describe('generic-schema safety — curated definitions must not leak', () => {
  // a hospital schema that happens to contain a `total_customers` column
  const foreign: Schema = {
    'clinic.fact_visits': [
      { name: 'visit_id', type: 'bigint' },
      { name: 'visit_date', type: 'date' },
      { name: 'total_customers', type: 'int' },
    ],
  };
  const foreignProduct: CatalogProduct = {
    product_name: 'jai_fact_visits',
    display_name: 'Visits',
    business_outcome: '',
    fact_tables: ['clinic.fact_visits'],
    dim_tables: [],
    kpis: ['labor_cost_per_customer'],
    maturity: 'incubating',
  };

  it('does not apply a curated formula whose inputs are absent', () => {
    expect(isCuratedMeasure('labor_cost_per_customer', foreign)).toBe(false);
  });

  it('reports such a KPI as unverified rather than Confirmed', () => {
    const c = deriveProduct(foreignProduct, foreign);
    const m = c.measures.find((x) => x.measure === 'labor_cost_per_customer');
    expect(m?.unverified).toBe(true);
    expect(m?.origin).not.toBe('user');
    // and must never quote a formula referencing a column this schema lacks
    expect(m?.formula).not.toContain('total_labor_cost');
  });

  it('flags it as unverified in sanitizeCatalog too', () => {
    const cat: Catalog = {
      domains: [
        { name: 'd', label: 'D', description: '', products: [foreignProduct] },
      ],
    };
    const out = sanitizeCatalog(cat, foreign, 'llm');
    expect(out.domains[0].products[0].unverifiedKpis).toEqual(['labor_cost_per_customer']);
  });
});
