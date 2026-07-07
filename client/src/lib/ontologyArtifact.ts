// Client helpers for the ontology artifact: assemble the model from the derived
// + curated components, POST it for serialization/persistence, and fetch it back
// (the Graph Explorer consumes the stored graph). Mirrors ontologyOverrides.ts.
import {
  buildArtifactModel,
  type ArtifactInput,
  type OntologyArtifact,
} from '../../../shared/ontologyArtifact';
import type { DerivedComponents } from './deriveComponents';

export type StoredArtifact = {
  artifact_id: string;
  schema_label: string;
  product: string;
  product_label?: string;
  iri?: string;
  graph_json?: string;
  model_json?: string;
  volume_path?: string;
  class_count?: number;
  objprop_count?: number;
  generated_by?: string;
  generated_at?: string;
};

export type ArtifactRuleInput = {
  id: string;
  name: string;
  if_conditions: string[];
  then_conclusion: string;
  concepts?: string[];
  evidence?: string;
};

// Build the OntologyArtifact model from the override-applied components + curation.
export function assembleArtifactInput(args: {
  components: DerivedComponents;
  links?: { link_type: string; url: string; label?: string }[];
  rules?: ArtifactRuleInput[];
  servingObject?: string;
  servingViewPresent?: boolean;
}): OntologyArtifact {
  const c = args.components;
  const input: ArtifactInput = {
    product: c.productName,
    productLabel: c.productLabel,
    classes: c.classes.map((k) => ({
      name: k.class,
      label: k.label,
      comment: k.comment,
      role: k.role,
      definition: k.definition,
      synonyms: k.synonyms,
    })),
    datatypeProps: c.mappings.map((m) => ({
      domainClass: m.class,
      property: m.property,
      type: m.type,
      role: m.role,
      pii: m.pii,
    })),
    // CONFIRMED relationships only (same predicate the serving view uses)
    objectProps: c.relationships
      .filter((r) => r.status === 'confirmed' || r.origin === 'user')
      .map((r) => ({
        from: r.from[0],
        to: r.to,
        predicate: r.predicate,
        fromColumn: r.fromColumn,
        toColumn: r.toColumn,
        confidence: r.confidence,
      })),
    reasoningRules: args.rules,
    links: args.links,
    servingObject: args.servingObject,
    servingViewPresent: args.servingViewPresent,
    graph: c.ontologyGraph,
  };
  return buildArtifactModel(input);
}

// a lightweight signature of the parts that should trigger a regenerate
export function artifactSignature(model: OntologyArtifact): string {
  return JSON.stringify({
    c: model.classes.map((x) => x.name).sort(),
    o: model.objectProps.map((x) => `${x.from}>${x.to}:${x.predicate}`).sort(),
    l: (model.links ?? []).map((x) => x.url).sort(),
    r: (model.reasoningRules ?? []).map((x) => x.id).sort(),
    s: Boolean(model.servingViewPresent),
  });
}

export async function generateArtifact(
  schemaLabel: string,
  product: string,
  model: OntologyArtifact
): Promise<{ ok: boolean; artifact_id?: string; volume_path?: string; volume_warning?: string; error?: string }> {
  try {
    const r = await fetch('/api/ontology-artifact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_label: schemaLabel, product, model }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchArtifact(schemaLabel: string, product: string): Promise<StoredArtifact | null> {
  try {
    const r = await fetch(
      `/api/ontology-artifact?schema=${encodeURIComponent(schemaLabel)}&product=${encodeURIComponent(product)}`
    );
    const d = await r.json();
    return d?.artifact ?? null;
  } catch {
    return null;
  }
}

export function artifactDownloadUrl(schemaLabel: string, product: string, format: 'ttl' | 'jsonld'): string {
  return `/api/ontology-artifact/download?schema=${encodeURIComponent(schemaLabel)}&product=${encodeURIComponent(product)}&format=${format}`;
}
