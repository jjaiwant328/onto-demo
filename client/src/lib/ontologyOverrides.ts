// User curation of the auto-derived ontology, persisted per schema in Lakebase
// (ontology_overrides). Overrides are layered over the heuristic/LLM-derived
// components to produce the EFFECTIVE components used everywhere.
import type { DerivedComponents, DerivedMapping, DerivedRelationship, ColRole } from './deriveComponents';

export type OverrideKind = 'entity' | 'relationship' | 'mapping' | 'edge_status';
export type OverrideAction =
  | 'rename'
  | 'merge'
  | 'set_role'
  | 'set_pii'
  | 'delete'
  | 'confirm'
  | 'reject';

export type OntologyOverride = {
  id: string;
  schema_label?: string;
  product?: string;
  kind: OverrideKind;
  ref: string; // entity name | relationship "from>to:predicate" | "class.column"
  action: OverrideAction;
  value?: string; // JSON payload
  created_by?: string;
  created_at?: string;
};

// stable ref keys
export const relRef = (r: Pick<DerivedRelationship, 'from' | 'to' | 'predicate'>) =>
  `${r.from.join(',')}>${r.to}:${r.predicate}`;
export const mapRef = (m: Pick<DerivedMapping, 'class' | 'column'>) => `${m.class}.${m.column}`;

function parseVal<T>(v: string | undefined): T | undefined {
  if (v == null || v === '') return undefined;
  try {
    return JSON.parse(v) as T;
  } catch {
    return v as unknown as T;
  }
}

// ---- server helpers ----
export async function fetchOntologyOverrides(schemaLabel: string): Promise<OntologyOverride[]> {
  try {
    const resp = await fetch(`/api/ontology-overrides?schema=${encodeURIComponent(schemaLabel)}`);
    const d = await resp.json();
    return Array.isArray(d?.overrides) ? d.overrides : [];
  } catch {
    return [];
  }
}

export async function saveOntologyOverride(args: {
  schema_label: string;
  product?: string;
  kind: OverrideKind;
  ref: string;
  action: OverrideAction;
  value?: unknown;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const resp = await fetch('/api/ontology-override', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await resp.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteOntologyOverride(id: string): Promise<boolean> {
  try {
    const resp = await fetch('/api/delete-ontology-override', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const d = await resp.json();
    return Boolean(d?.ok);
  } catch {
    return false;
  }
}

// ---- apply overrides → EFFECTIVE components ----
export function applyOntologyOverrides(
  components: DerivedComponents,
  overrides: OntologyOverride[]
): DerivedComponents {
  if (!overrides.length) return components;

  // entity renames + merges (applied to class ids everywhere)
  const renameMap = new Map<string, string>(); // oldClass -> newLabel/id
  const mergeMap = new Map<string, string>(); // sourceClass -> targetClass
  for (const o of overrides) {
    if (o.kind !== 'entity') continue;
    if (o.action === 'rename') {
      const v = parseVal<{ name?: string }>(o.value);
      if (v?.name) renameMap.set(o.ref, v.name);
    } else if (o.action === 'merge') {
      const v = parseVal<{ target?: string }>(o.value);
      if (v?.target) mergeMap.set(o.ref, v.target);
    }
  }
  const remapClass = (c: string): string => {
    const merged = mergeMap.get(c) ?? c;
    return renameMap.get(merged) ?? merged;
  };

  // mapping role / pii overrides + deletes, keyed by class.column
  const mapRole = new Map<string, ColRole>();
  const mapPii = new Map<string, boolean>();
  for (const o of overrides) {
    if (o.kind !== 'mapping') continue;
    if (o.action === 'set_role') {
      const v = parseVal<{ role?: ColRole }>(o.value);
      if (v?.role) mapRole.set(o.ref, v.role);
    } else if (o.action === 'set_pii') {
      const v = parseVal<{ pii?: boolean }>(o.value);
      mapPii.set(o.ref, v?.pii !== false);
    }
  }

  // relationship deletes + edge_status confirm/reject, keyed by relRef
  const relDeleted = new Set<string>();
  const relStatus = new Map<string, 'confirmed' | 'rejected'>();
  for (const o of overrides) {
    if (o.kind === 'relationship' && o.action === 'delete') relDeleted.add(o.ref);
    if (o.kind === 'edge_status') {
      if (o.action === 'confirm') relStatus.set(o.ref, 'confirmed');
      if (o.action === 'reject') relStatus.set(o.ref, 'rejected');
    }
  }

  const classes = components.classes
    .filter((c) => !mergeMap.has(c.class)) // merged-away classes disappear
    .map((c) => {
      const newId = remapClass(c.class);
      return newId !== c.class ? { ...c, class: newId, label: newId } : c;
    });

  const mappings: DerivedMapping[] = components.mappings.map((m) => {
    const cls = remapClass(m.class);
    const key = `${m.class}.${m.column}`;
    const role = mapRole.get(key);
    const pii = mapPii.get(key);
    const changed = cls !== m.class || role != null || pii != null;
    return changed
      ? {
          ...m,
          class: cls,
          role: role ?? m.role,
          pii: pii ?? m.pii,
          origin: role != null || pii != null ? 'user' : m.origin,
        }
      : m;
  });

  const relationships: DerivedRelationship[] = components.relationships
    .map((r) => {
      const ref = relRef(r);
      const status = relStatus.get(ref);
      const remapped = {
        ...r,
        from: r.from.map(remapClass),
        to: remapClass(r.to),
        status: status ?? r.status,
        origin: status === 'confirmed' ? ('user' as const) : r.origin,
        confidence: status === 'confirmed' ? 1 : r.confidence,
      };
      return { remapped, ref };
    })
    .filter(({ ref }) => !relDeleted.has(ref))
    .map(({ remapped }) => remapped);

  return { ...components, classes, mappings, relationships };
}
