// generateServingView emits DDL a user is invited to run against their warehouse.
// The two claims that matter are: it only joins on columns that PROVABLY exist on
// both sides (the fix for "unresolved column" CREATE VIEW failures), and it honours
// differently-named keys (cust_id ↔ customer_id) resolved via fromColumn/toColumn.
// Both were previously only verified by hand in a browser.
import { describe, it, expect } from 'vitest';
import { generateServingView } from './servingView';
import type {
  CatalogProduct,
  DerivedComponents,
  DerivedRelationship,
  DerivedTable,
} from './deriveComponents';

const factTable: DerivedTable = {
  table: 'sales.fact_orders',
  label: 'Orders',
  role: 'fact',
  columns: [
    { name: 'order_id', type: 'bigint', role: 'key' },
    { name: 'cust_id', type: 'string', role: 'key' },
    { name: 'store_number', type: 'int', role: 'key' },
    { name: 'net_sales', type: 'double', role: 'measure' },
  ],
};
const custDim: DerivedTable = {
  table: 'sales.dim_customer',
  label: 'Customer',
  role: 'dim',
  columns: [
    { name: 'customer_id', type: 'string', role: 'key' },
    { name: 'customer_name', type: 'string', role: 'attribute' },
  ],
};
const storeDim: DerivedTable = {
  table: 'sales.dim_store',
  label: 'Store',
  role: 'dim',
  columns: [
    { name: 'store_number', type: 'int', role: 'key' },
    { name: 'store_name', type: 'string', role: 'attribute' },
  ],
};

function components(
  tables: DerivedTable[],
  relationships: DerivedRelationship[]
): DerivedComponents {
  // only the fields generateServingView reads; the rest of the shape is irrelevant here
  return { tables, relationships } as unknown as DerivedComponents;
}

const product: CatalogProduct = {
  product_name: 'orders',
  display_name: 'Orders',
  business_outcome: '',
  fact_tables: ['sales.fact_orders'],
  dim_tables: ['sales.dim_customer', 'sales.dim_store'],
  kpis: ['net_sales'],
  maturity: 'incubating',
};

const confirmed = (r: Partial<DerivedRelationship>): DerivedRelationship => ({
  predicate: 'x',
  label: 'x',
  from: ['fact_orders'],
  to: 'dim_store',
  status: 'confirmed',
  ...r,
});

describe('generateServingView — join column resolution', () => {
  it('joins differently-named keys using fromColumn/toColumn', () => {
    const out = generateServingView(
      product,
      components(
        [factTable, custDim],
        [
          confirmed({
            predicate: 'customer',
            to: 'dim_customer',
            fromColumn: 'cust_id',
            toColumn: 'customer_id',
          }),
        ]
      )
    );
    expect(out.joins).toBe(1);
    expect(out.sql).toContain('LEFT JOIN sales.dim_customer');
    // child key on the fact, parent key on the dim — not the same name on both sides
    expect(out.sql).toMatch(/ON f\.cust_id = \w+\.customer_id/);
  });

  it('falls back to the predicate when both sides share a key name', () => {
    const out = generateServingView(
      product,
      components([factTable, storeDim], [confirmed({ predicate: 'store_number', to: 'dim_store' })])
    );
    expect(out.joins).toBe(1);
    expect(out.sql).toMatch(/ON f\.store_number = \w+\.store_number/);
  });
});

describe('generateServingView — only emits provable joins', () => {
  it('skips a join whose parent column does not exist, and says why', () => {
    const out = generateServingView(
      product,
      components(
        [factTable, custDim],
        [
          confirmed({
            predicate: 'customer',
            to: 'dim_customer',
            fromColumn: 'cust_id',
            toColumn: 'nope_missing', // not a column on dim_customer
          }),
        ]
      )
    );
    expect(out.joins).toBe(0);
    expect(out.sql).not.toContain('nope_missing');
    expect(out.note).toMatch(/Skipped 1/);
    expect(out.note).toMatch(/unresolved key/);
  });

  it('skips a join whose child column does not exist on the fact', () => {
    const out = generateServingView(
      product,
      components(
        [factTable, storeDim],
        [
          confirmed({
            predicate: 'store',
            to: 'dim_store',
            fromColumn: 'not_on_fact',
            toColumn: 'store_number',
          }),
        ]
      )
    );
    expect(out.joins).toBe(0);
    expect(out.note).toMatch(/Skipped 1/);
  });

  // An LLM suggestion can reach here with an empty column (the API's sanitizer
  // treats column as optional), so the generator must not emit `f. = alias.`.
  it('does not emit a join for an empty join column', () => {
    const out = generateServingView(
      product,
      components(
        [factTable, storeDim],
        [confirmed({ predicate: '', to: 'dim_store', fromColumn: '', toColumn: '' })]
      )
    );
    expect(out.joins).toBe(0);
    expect(out.sql).not.toMatch(/ON f\. =/);
  });
});

describe('generateServingView — relationship selection', () => {
  it('ignores relationships that are neither confirmed nor user-authored', () => {
    const out = generateServingView(
      product,
      components(
        [factTable, storeDim],
        [{ predicate: 'store_number', label: '', from: ['fact_orders'], to: 'dim_store', origin: 'heuristic' }]
      )
    );
    expect(out.joins).toBe(0);
    expect(out.note).toMatch(/No confirmed fact→dim relationships/);
  });

  it('accepts a user-authored relationship even without confirmed status', () => {
    const out = generateServingView(
      product,
      components(
        [factTable, storeDim],
        [
          {
            predicate: 'store_number',
            label: '',
            from: ['fact_orders'],
            to: 'dim_store',
            origin: 'user',
          },
        ]
      )
    );
    expect(out.joins).toBe(1);
  });

  it('joins a given dimension only once', () => {
    const out = generateServingView(
      product,
      components(
        [factTable, storeDim],
        [
          confirmed({ predicate: 'store_number', to: 'dim_store' }),
          confirmed({ predicate: 'store_number', to: 'dim_store' }),
        ]
      )
    );
    expect(out.joins).toBe(1);
    expect(out.sql.match(/LEFT JOIN/g) ?? []).toHaveLength(1);
  });

  it('ignores a relationship whose "from" is not the base fact', () => {
    const out = generateServingView(
      product,
      components(
        [factTable, storeDim],
        [confirmed({ predicate: 'store_number', from: ['dim_customer'], to: 'dim_store' })]
      )
    );
    expect(out.joins).toBe(0);
  });
});

describe('generateServingView — target and degenerate cases', () => {
  it('targets the product’s own catalog, never the demo catalog', () => {
    const out = generateServingView(product, components([factTable], []));
    expect(out.name).toBe('sales.governed.jai_orders_serving');
    expect(out.name).not.toContain('jai_ontos');
    expect(out.sql).not.toContain('jai_ontos');
  });

  it('reports cleanly when there is no fact table at all', () => {
    const out = generateServingView(
      { ...product, fact_tables: [] },
      components([], [])
    );
    expect(out.joins).toBe(0);
    expect(out.note).toBe('No fact table.');
    expect(out.sql).toMatch(/cannot generate a serving view/);
  });

  it('still produces a fact-only SELECT when nothing is confirmed', () => {
    const out = generateServingView(product, components([factTable, storeDim], []));
    expect(out.joins).toBe(0);
    expect(out.sql).toContain('FROM sales.fact_orders f');
    expect(out.sql).toContain('CREATE OR REPLACE VIEW');
  });
});
