// User curation of the auto-derived ontology, persisted per schema in Lakebase
// (ontology_overrides). Overrides are layered over the heuristic/LLM-derived
// components to produce the EFFECTIVE components used everywhere.
import type {
  DerivedComponents,
  DerivedMapping,
  DerivedRelationship,
  ColRole,
} from './deriveComponents';

export type OverrideKind =
  | 'entity'
  | 'relationship'
  | 'mapping'
  | 'edge_status'
  | 'glossary'
  | 'suggest_status';
export type OverrideAction =
  | 'rename'
  | 'merge'
  | 'set_role'
  | 'set_pii'
  | 'delete'
  | 'confirm'
  | 'reject'
  | 'add' // add a relationship (from an accepted LLM suggestion)
  | 'define'; // glossary definition + synonyms

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

// ---- LLM relationship suggestions ----
export type SuggestedRelationship = {
  from: string;
  to: string;
  predicate: string;
  column: string; // join column on `from`
  toColumn: string; // matching column on `to` (may differ from `column`)
  rationale: string;
  confidence: number;
};
export async function suggestRelationships(args: {
  product: string;
  componentsSummary?: string;
  tables: { table: string; columns: string[] }[];
}): Promise<SuggestedRelationship[]> {
  try {
    const resp = await fetch('/api/suggest-relationships', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const d = await resp.json();
    return Array.isArray(d?.suggestions) ? d.suggestions : [];
  } catch {
    return [];
  }
}

// ---- validate ontology against live data ----
export type ValidationResult = {
  product?: string;
  tables: {
    table: string;
    row_count?: number;
    keys?: { column: string; null_pct?: number; distinct_pct?: number; error?: string }[];
    error?: string;
  }[];
  relationships: {
    from: string;
    to: string;
    column: string;
    from_column?: string;
    to_column?: string;
    hit_rate?: number | null;
    child_rows?: number;
    error?: string;
  }[];
  // Present when the server capped the run. Without this a partial validation
  // renders identically to a full one, which would overstate the coverage.
  truncated?: {
    tables_checked: number;
    tables_total: number;
    relationships_checked: number;
    relationships_total: number;
    max_keys_per_table: number;
    tables_with_extra_keys: string[];
  } | null;
};
export async function validateOntology(args: {
  product: string;
  tables: { table: string; keys?: string[] }[];
  relationships: { from: string; to: string; column: string; fromColumn?: string; toColumn?: string }[];
}): Promise<ValidationResult | null> {
  try {
    const resp = await fetch('/api/validate-ontology', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await resp.json();
  } catch {
    return null;
  }
}

// ---- check whether a governed serving view actually exists in the warehouse ----
export async function checkServingView(object: string): Promise<{ present: boolean; error?: string }> {
  try {
    const resp = await fetch(`/api/serving-view-check?object=${encodeURIComponent(object)}`);
    return await resp.json();
  } catch (e) {
    return { present: false, error: String(e) };
  }
}

// ---- verify a generated serving-view's SQL compiles against the warehouse ----
export async function verifyViewSql(sql: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch('/api/verify-view-sql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
    return await resp.json();
  } catch (e) {
    return { ok: false, error: String(e) };
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
  // added relationships (accepted LLM suggestions)
  const relAdded: DerivedRelationship[] = [];
  for (const o of overrides) {
    if (o.kind === 'relationship' && o.action === 'delete') relDeleted.add(o.ref);
    if (o.kind === 'relationship' && o.action === 'add') {
      const v = parseVal<{
        from?: string;
        to?: string;
        predicate?: string;
        column?: string;
        toColumn?: string;
      }>(o.value);
      if (v?.from && v?.to && v?.predicate) {
        relAdded.push({
          predicate: v.predicate,
          label: `${v.predicate} → ${v.to}`,
          from: [v.from],
          to: v.to,
          // preserve differently-named join keys so validation can join them
          fromColumn: v.column,
          toColumn: v.toColumn ?? v.column,
          origin: 'user',
          confidence: 1,
          status: 'confirmed',
        });
      }
    }
    if (o.kind === 'edge_status') {
      if (o.action === 'confirm') relStatus.set(o.ref, 'confirmed');
      if (o.action === 'reject') relStatus.set(o.ref, 'rejected');
    }
  }

  // glossary: definition + synonyms keyed by entity/measure name
  const glossary = new Map<string, { definition?: string; synonyms?: string[]; term_type?: string }>();
  for (const o of overrides) {
    if (o.kind !== 'glossary') continue;
    const v = parseVal<{ definition?: string; synonyms?: string[]; term_type?: string }>(o.value);
    if (v) glossary.set(o.ref, v);
  }

  const classes = components.classes
    .filter((c) => !mergeMap.has(c.class)) // merged-away classes disappear
    .map((c) => {
      const newId = remapClass(c.class);
      const g = glossary.get(c.class) ?? glossary.get(newId);
      // A renamed entity is curated, not derived — record both the new provenance
      // and the original derived name so the change stays auditable.
      const base =
        newId !== c.class
          ? {
              ...c,
              class: newId,
              label: newId,
              origin: 'user' as const,
              renamedFrom: c.class,
              evidence: `renamed from "${c.class}" by a person`,
            }
          : { ...c };
      if (g) {
        base.definition = g.definition ?? base.definition;
        base.synonyms = g.synonyms ?? base.synonyms;
        // a curated definition is a human assertion about meaning
        base.origin = 'user';
        base.evidence = 'business definition supplied by a person';
      }
      return base;
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
          origin: role != null ? 'user' : m.origin,
          // A PII decision is the most governance-sensitive edit here, so track it
          // separately from the role override — otherwise flagging PII silently
          // reads as if the role had been curated too.
          piiOrigin: pii != null ? 'user' : m.piiOrigin,
          evidence: role != null ? 'role set by a person, overriding the derived role' : m.evidence,
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
        evidence:
          status === 'confirmed'
            ? 'confirmed by a person — treated as a real relationship'
            : r.evidence,
      };
      return { remapped, ref };
    })
    .filter(({ ref }) => !relDeleted.has(ref))
    .map(({ remapped }) => remapped);

  // append accepted LLM-suggested relationships (de-dupe against existing, and
  // honour a delete override so a user-added edge can be removed like any other)
  const existingRefs = new Set(relationships.map(relRef));
  for (const add of relAdded) {
    const addRef = relRef(add);
    if (relDeleted.has(addRef)) continue;
    if (!existingRefs.has(addRef)) {
      // a reject override applies to added edges too
      const status = relStatus.get(addRef);
      relationships.push(status ? { ...add, status } : add);
      existingRefs.add(addRef);
    }
  }

  // glossary on measures (definition + synonyms by measure name)
  const measures =
    glossary.size > 0
      ? components.measures.map((m) => {
          const g = glossary.get(m.measure);
          return g ? { ...m, definition: g.definition ?? m.definition, synonyms: g.synonyms ?? m.synonyms } : m;
        })
      : components.measures;

  return { ...components, classes, mappings, relationships, measures };
}

// which suggestion refs the user has rejected (to hide them from re-suggest UI)
export function rejectedSuggestionRefs(overrides: OntologyOverride[]): Set<string> {
  const s = new Set<string>();
  for (const o of overrides) if (o.kind === 'relationship' && o.action === 'reject') s.add(o.ref);
  return s;
}
