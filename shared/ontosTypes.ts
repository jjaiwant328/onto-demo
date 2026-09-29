// Types for the ontos integration. ontos (the deployed Databricks Labs app)
// is the governance system of record this app publishes contracts and data
// products to; these types are the narrow slice of it the app consumes.
//
// Everything here is modeled permissively — unknown extra keys are allowed —
// because ontos' real API is external and evolves independently of this repo.
// Field access must tolerate missing values; see server/ontosClient.ts for the
// mapping onto these shapes.

/** One column of a contract's schema, as this app reasons about it. */
export interface OdcsContractField {
  name: string;
  type: string;
  primaryKey?: boolean;
  required?: boolean;
  description?: string;
  // real ODCS documents carry more per-field metadata (physicalType, logicalType, ...)
  [key: string]: unknown;
}

/**
 * An Open Data Contract Standard (ODCS) v3.1.0 document.
 *
 * The sections below are how this app slices an ODCS document; a real
 * document (e.g. ontology/odcs/*.odcs.yaml) is flat and may not use them
 * verbatim — hence every section is optional and extra keys are tolerated.
 */
export interface OdcsContract {
  // the standard writes 'v3.1.0'; the bare form is kept for our own tooling
  apiVersion: '3.1.0' | 'v3.1.0';
  kind: 'DataContract';
  metadata?: {
    id?: string;
    name?: string;
    domain?: string;
    owner?: string;
    status?: string;
    // label of the schema/serving object this contract governs
    schema?: string;
    [key: string]: unknown;
  };
  schema?: {
    fields?: OdcsContractField[];
    [key: string]: unknown;
  };
  sla?: {
    freshness?: string | { [key: string]: unknown };
    [key: string]: unknown;
  };
  quality?: {
    checks?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** The outcome of asking ontos whether a contract is currently satisfied. */
export interface ContractValidationState {
  contract_id: string;
  status: 'pass' | 'fail' | 'error' | 'pending' | 'unknown';
  checks: Array<{
    name: string;
    status: 'pass' | 'fail' | 'error';
    message?: string;
  }>;
  /** the raw contract document the state was derived from, for inspection */
  raw?: unknown;
}

/** The slice of an ontos data product this app displays. */
export interface DataProductSummary {
  id: string;
  name: string;
  status?: string;
  domain?: string;
  owner?: string;
}

/** Configuration for server/ontosClient.ts. `fetchImpl` is injectable for tests. */
export interface OntosClientConfig {
  baseUrl: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}
