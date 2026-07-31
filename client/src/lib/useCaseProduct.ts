// Client helpers for use-case data-product DRAFTS. A use case from the Domain
// Analysis can be described as a data product (KPIs, tables, proposed Genie
// spaces + metric views). Drafts stage separately; only status='completed'
// drafts surface in the Data Products view. Mirrors domainAnalysis.ts.
import type { UseCase } from './domainAnalysis';

export type DraftStatus = 'draft' | 'completed';

export type UseCaseProductSpec = {
  title: string;
  summary: string;
  kpis: { name: string; definition: string }[];
  tables: string[];
  genie_spaces: { name: string; purpose: string }[];
  metric_views: { name: string; dimensions: string[]; measures: string[] }[];
  products: string[];
};

export type UseCaseProductDraft = {
  draft_id: string;
  schema_label: string;
  domain_name: string;
  use_case_title: string;
  spec_json: string; // JSON of UseCaseProductSpec
  llm_used: boolean;
  status: DraftStatus;
  created_by?: string;
  updated_at?: string;
};

export function parseSpec(draft: UseCaseProductDraft): UseCaseProductSpec | null {
  try {
    return JSON.parse(draft.spec_json) as UseCaseProductSpec;
  } catch {
    return null;
  }
}

export type DescribeResult = {
  ok: boolean;
  draft_id?: string;
  llm_used?: boolean;
  spec?: UseCaseProductSpec;
  persist_warning?: string;
  error?: string;
};

// Describe a use case as a data product (persists a draft, status='draft').
export async function describeUseCaseProduct(args: {
  schema_label: string;
  domain_name: string;
  use_case: UseCase;
}): Promise<DescribeResult> {
  try {
    const resp = await fetch('/api/use-case-product/describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_label: args.schema_label,
        domain_name: args.domain_name,
        use_case: {
          title: args.use_case.title,
          value_driver: args.use_case.value_driver,
          description: args.use_case.description,
          kpis: [], // use cases carry no KPI list directly; server derives from tables/products
          tables: args.use_case.tables,
          products: args.use_case.products,
        },
      }),
    });
    return (await resp.json()) as DescribeResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchUseCaseProducts(
  schemaLabel: string,
  domainName?: string
): Promise<UseCaseProductDraft[]> {
  try {
    const q = domainName
      ? `?schema=${encodeURIComponent(schemaLabel)}&domain=${encodeURIComponent(domainName)}`
      : `?schema=${encodeURIComponent(schemaLabel)}`;
    const resp = await fetch(`/api/use-case-products${q}`);
    const d = (await resp.json()) as { drafts?: UseCaseProductDraft[] };
    return Array.isArray(d.drafts) ? d.drafts : [];
  } catch {
    return [];
  }
}

export async function setUseCaseProductStatus(
  draftId: string,
  status: DraftStatus
): Promise<boolean> {
  try {
    const resp = await fetch('/api/use-case-product/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft_id: draftId, status }),
    });
    const d = (await resp.json()) as { ok?: boolean };
    return Boolean(d.ok);
  } catch {
    return false;
  }
}

export async function deleteUseCaseProduct(draftId: string): Promise<boolean> {
  try {
    const resp = await fetch('/api/use-case-product/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft_id: draftId }),
    });
    const d = (await resp.json()) as { ok?: boolean };
    return Boolean(d.ok);
  } catch {
    return false;
  }
}
