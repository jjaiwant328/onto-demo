// Catalog-driven app context, sourced from the ACTIVE catalog (default = bundled
// catalog.json/schema.json; replaced at runtime by an uploaded describe-extended
// CSV). Selecting a product derives its components from the active schema via
// deriveProduct — the reusable "skill" every section consumes. The enterprise
// map + per-product contracts are derived from the active catalog too, so an
// upload regenerates domains → products → components → graph → contracts.
import { createContext, useContext, useMemo, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import catalogJson from '../data/catalog.json';
import schemaJson from '../data/schema.json';
import {
  deriveProduct,
  buildEnterpriseGraph,
  type Catalog,
  type CatalogDomain,
  type CatalogProduct,
  type DerivedComponents,
  type EnterpriseGraph,
  type Schema,
} from './deriveComponents';
import { parseDescribeCsv, buildCatalog } from './catalogGen';

const DEFAULT_CATALOG = catalogJson as unknown as Catalog;
const DEFAULT_SCHEMA = schemaJson as unknown as Schema;

const DEFAULT_DOMAIN = 'store_operations_labor';
const DEFAULT_PRODUCT = 'jai_store_traffic_labor_efficiency';

export type CatalogSource = 'default' | 'uploaded' | 'uploaded+llm';

type ProductContextValue = {
  // active catalog source + controls
  catalogSource: CatalogSource;
  loadFromCsv: (csvText: string) => { domains: number; products: number };
  applyGeneratedCatalog: (catalog: Catalog, schema: Schema, source: CatalogSource) => void;
  resetToDefault: () => void;
  schema: Schema;
  catalog: Catalog;
  // selection
  domains: CatalogDomain[];
  selectedDomain: CatalogDomain;
  setSelectedDomain: (name: string) => void;
  productsInDomain: CatalogProduct[];
  selectedProduct: CatalogProduct;
  setSelectedProduct: (name: string) => void;
  components: DerivedComponents;
  // enterprise map + highlight
  enterpriseGraph: EnterpriseGraph;
  enterpriseHighlight: Set<string>;
};

const ProductContext = createContext<ProductContextValue | null>(null);

export function ProductProvider({ children }: { children: ReactNode }) {
  // active catalog/schema (default = bundled; replaced on upload)
  const [active, setActive] = useState<{ catalog: Catalog; schema: Schema; source: CatalogSource }>(
    { catalog: DEFAULT_CATALOG, schema: DEFAULT_SCHEMA, source: 'default' }
  );
  const { catalog, schema } = active;
  const domains = catalog.domains;

  const [domainName, setDomainName] = useState<string>(DEFAULT_DOMAIN);
  const [productName, setProductName] = useState<string>(DEFAULT_PRODUCT);

  const selectedDomain = useMemo(
    () => domains.find((d) => d.name === domainName) ?? domains[0],
    [domains, domainName]
  );
  const productsInDomain = selectedDomain.products;
  const selectedProduct = useMemo(
    () => productsInDomain.find((p) => p.product_name === productName) ?? productsInDomain[0],
    [productsInDomain, productName]
  );

  const setSelectedDomain = (name: string) => {
    const d = domains.find((x) => x.name === name) ?? domains[0];
    setDomainName(d.name);
    setProductName(d.products[0]?.product_name ?? '');
  };
  const setSelectedProduct = (name: string) => {
    const owning = domains.find((d) => d.products.some((p) => p.product_name === name));
    if (owning && owning.name !== domainName) setDomainName(owning.name);
    setProductName(name);
  };

  // ---- catalog loading controls ----
  const applyGeneratedCatalog = useCallback(
    (newCatalog: Catalog, newSchema: Schema, source: CatalogSource) => {
      setActive({ catalog: newCatalog, schema: newSchema, source });
      const d0 = newCatalog.domains[0];
      setDomainName(d0?.name ?? '');
      setProductName(d0?.products[0]?.product_name ?? '');
    },
    []
  );

  const loadFromCsv = useCallback(
    (csvText: string) => {
      const newSchema = parseDescribeCsv(csvText);
      const newCatalog = buildCatalog(newSchema);
      applyGeneratedCatalog(newCatalog, newSchema, 'uploaded');
      return {
        domains: newCatalog.domains.length,
        products: newCatalog.domains.reduce((n, d) => n + d.products.length, 0),
      };
    },
    [applyGeneratedCatalog]
  );

  const resetToDefault = useCallback(() => {
    setActive({ catalog: DEFAULT_CATALOG, schema: DEFAULT_SCHEMA, source: 'default' });
    setDomainName(DEFAULT_DOMAIN);
    setProductName(DEFAULT_PRODUCT);
  }, []);

  // ---- derived artifacts (recomputed when active catalog/selection changes) ----
  const components = useMemo(
    () => deriveProduct(selectedProduct, schema),
    [selectedProduct, schema]
  );
  const enterpriseGraph = useMemo(() => buildEnterpriseGraph(catalog, schema), [catalog, schema]);
  const enterpriseHighlight = useMemo(
    () => enterpriseGraph.highlightFor(selectedDomain.name, selectedProduct.product_name),
    [enterpriseGraph, selectedDomain.name, selectedProduct.product_name]
  );

  const value: ProductContextValue = {
    catalogSource: active.source,
    loadFromCsv,
    applyGeneratedCatalog,
    resetToDefault,
    schema,
    catalog,
    domains,
    selectedDomain,
    setSelectedDomain,
    productsInDomain,
    selectedProduct,
    setSelectedProduct,
    components,
    enterpriseGraph,
    enterpriseHighlight,
  };

  return <ProductContext.Provider value={value}>{children}</ProductContext.Provider>;
}

export function useProduct(): ProductContextValue {
  const ctx = useContext(ProductContext);
  if (!ctx) throw new Error('useProduct must be used within ProductProvider');
  return ctx;
}
