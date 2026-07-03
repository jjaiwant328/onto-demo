// Client helpers for product links (Genie Space / AI-BI dashboard) persisted to
// jai_ontos.demo_schema.jai_product_links. Surfaced in the Action Center
// "Further analysis" panel and the Data Products "Genie Space" column.

export type ProductLink = {
  link_id: string;
  schema_label?: string;
  domain?: string;
  product?: string;
  link_type: 'genie' | 'dashboard' | string;
  url: string;
  label?: string;
  created_by?: string;
  created_at?: string;
};

export async function fetchProductLinks(product?: string): Promise<ProductLink[]> {
  try {
    const qs = product ? `?product=${encodeURIComponent(product)}` : '';
    const resp = await fetch(`/api/product-links${qs}`);
    const d = await resp.json();
    return Array.isArray(d?.links) ? d.links : [];
  } catch {
    return [];
  }
}

export async function attachLink(args: {
  schema_label: string;
  domain: string;
  product: string;
  link_type: 'genie' | 'dashboard';
  url: string;
  label?: string;
}): Promise<{ ok: boolean; link_id?: string; error?: string }> {
  try {
    const resp = await fetch('/api/attach-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await resp.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteLink(link_id: string): Promise<boolean> {
  try {
    const resp = await fetch('/api/delete-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ link_id }),
    });
    const d = await resp.json();
    return Boolean(d?.ok);
  } catch {
    return false;
  }
}
