// Catalog-driven app context. The domain/product catalog (6 domains × 4 products)
// comes from catalog.json; selecting a product derives its components at runtime
// from the real fc_entdata_gold schema (schema.json) via deriveProduct — the
// reusable "skill" every section consumes. Exactly one product is `live`
// (jai_store_traffic_labor_efficiency) and keeps its warehouse-backed behavior.
import { createContext, useContext, useMemo, useState } from 'react';
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

const catalog = catalogJson as unknown as Catalog;
const schema = schemaJson as unknown as Schema;
// the enterprise-wide map is built once for the whole app
const enterpriseGraph = buildEnterpriseGraph(catalog, schema);

const DEFAULT_DOMAIN = 'store_operations_labor';
const DEFAULT_PRODUCT = 'jai_store_traffic_labor_efficiency';

type ProductContextValue = {
  domains: CatalogDomain[];
  selectedDomain: CatalogDomain;
  setSelectedDomain: (name: string) => void;
  productsInDomain: CatalogProduct[];
  selectedProduct: CatalogProduct;
  setSelectedProduct: (name: string) => void;
  components: DerivedComponents;
  // enterprise-wide map (Explore tab) + the current selection's highlight set
  enterpriseGraph: EnterpriseGraph;
  enterpriseHighlight: Set<string>;
};

const ProductContext = createContext<ProductContextValue | null>(null);

export function ProductProvider({ children }: { children: ReactNode }) {
  const domains = catalog.domains;

  const [domainName, setDomainName] = useState<string>(DEFAULT_DOMAIN);
  const selectedDomain = useMemo(
    () => domains.find((d) => d.name === domainName) ?? domains[0],
    [domains, domainName]
  );
  const productsInDomain = selectedDomain.products;

  const [productName, setProductName] = useState<string>(DEFAULT_PRODUCT);
  const selectedProduct = useMemo(
    () => productsInDomain.find((p) => p.product_name === productName) ?? productsInDomain[0],
    [productsInDomain, productName]
  );

  const setSelectedDomain = (name: string) => {
    const d = domains.find((x) => x.name === name) ?? domains[0];
    setDomainName(d.name);
    // reset to the domain's first product
    setProductName(d.products[0]?.product_name ?? '');
  };
  // selecting a product also syncs the domain to the product's owning domain
  // (so clicking a product node in the enterprise map updates both selectors)
  const setSelectedProduct = (name: string) => {
    const owning = domains.find((d) => d.products.some((p) => p.product_name === name));
    if (owning && owning.name !== domainName) setDomainName(owning.name);
    setProductName(name);
  };

  const components = useMemo(
    () => deriveProduct(selectedProduct, schema),
    [selectedProduct]
  );

  const enterpriseHighlight = useMemo(
    () => enterpriseGraph.highlightFor(selectedDomain.name, selectedProduct.product_name),
    [selectedDomain.name, selectedProduct.product_name]
  );

  const value: ProductContextValue = {
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
