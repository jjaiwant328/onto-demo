// Ontology artifact serializer — turns the derived + curated ontology of a data
// product into a portable OWL/TTL + JSON-LD artifact (plus a cytoscape-ready
// graph the viewer consumes). Self-contained (no client/server imports) so both
// sides can use it: the client assembles the model from its DerivedComponents,
// the server serializes + persists it.

export type ArtifactClass = {
  name: string; // class id (short, e.g. jai_inventory_event)
  label: string;
  comment?: string;
  role?: string; // fact | dim | product | view
  definition?: string; // glossary
  synonyms?: string[];
};
export type ArtifactDatatypeProp = {
  domainClass: string;
  property: string; // column name
  type: string; // SQL type
  role?: string; // key | attribute | measure
  pii?: boolean;
};
export type ArtifactObjectProp = {
  from: string; // domain class
  to: string; // range class
  predicate: string; // join column / label
  fromColumn?: string;
  toColumn?: string;
  confidence?: number;
};
export type ArtifactSubclass = { child: string; parent: string };
export type ArtifactRule = {
  id: string;
  name: string;
  if_conditions: string[];
  then_conclusion: string;
  concepts?: string[];
  evidence?: string;
};
export type ArtifactLink = { link_type: string; url: string; label?: string };

export type ArtifactInput = {
  product: string;
  productLabel: string;
  scopeLabel?: string;
  iri?: string; // IRI base; defaults from product
  classes: ArtifactClass[];
  datatypeProps: ArtifactDatatypeProp[];
  objectProps: ArtifactObjectProp[]; // CONFIRMED relationships only (caller filters)
  subclassAxioms?: ArtifactSubclass[];
  reasoningRules?: ArtifactRule[];
  links?: ArtifactLink[];
  servingObject?: string;
  servingViewPresent?: boolean;
  // cytoscape-ready graph copied from components.ontologyGraph; the viewer reads this
  graph?: unknown;
};

export type OntologyArtifact = ArtifactInput & {
  iri: string;
  generated_at: string;
};

// ---- helpers ----------------------------------------------------------------
const IRI_BASE_DEFAULT = 'https://qsr.example/onto';
// valid IRI local-name (letters, digits, underscore)
const localName = (s: string) => (s || '').replace(/[^A-Za-z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'x';
const esc = (s: string) => (s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');

// SQL type → XSD range
export function sqlToXsd(sqlType: string): string {
  const t = (sqlType || '').toLowerCase();
  if (/^(int|integer|bigint|smallint|tinyint|long)/.test(t)) return 'xsd:integer';
  if (/^(decimal|numeric|double|float|real)/.test(t)) return 'xsd:decimal';
  if (/^bool/.test(t)) return 'xsd:boolean';
  if (/^timestamp/.test(t)) return 'xsd:dateTime';
  if (/^date/.test(t)) return 'xsd:date';
  return 'xsd:string';
}

export function buildArtifactModel(input: ArtifactInput): OntologyArtifact {
  const iri = input.iri ?? `${IRI_BASE_DEFAULT}/${localName(input.product)}#`;
  return { ...input, iri, generated_at: new Date().toISOString() };
}

// ---- Turtle / OWL serialization --------------------------------------------
export function serializeTtl(a: OntologyArtifact): string {
  const L: string[] = [];
  L.push(`@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .`);
  L.push(`@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`);
  L.push(`@prefix owl: <http://www.w3.org/2002/07/owl#> .`);
  L.push(`@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`);
  L.push(`@prefix skos: <http://www.w3.org/2004/02/skos/core#> .`);
  L.push(`@prefix dcterms: <http://purl.org/dc/terms/> .`);
  L.push(`@prefix qsr: <${a.iri}> .`);
  L.push('');
  // ontology header + reasoning-rule annotations
  L.push(`<${a.iri}> a owl:Ontology ;`);
  L.push(`  rdfs:label "${esc(a.productLabel)} ontology" ;`);
  L.push(`  dcterms:created "${a.generated_at}"^^xsd:dateTime ;`);
  if (a.servingObject) L.push(`  rdfs:comment "Serving object: ${esc(a.servingObject)} (present: ${a.servingViewPresent ? 'yes' : 'no'})" ;`);
  for (const r of a.reasoningRules ?? [])
    L.push(`  rdfs:comment "RULE ${esc(r.id)} — IF ${esc(r.if_conditions.join(' AND '))} THEN ${esc(r.then_conclusion)}" ;`);
  for (const lk of a.links ?? [])
    L.push(`  rdfs:seeAlso <${lk.url}> ;`);
  L.push(`  dcterms:description "Derived + curated ontology for ${esc(a.productLabel)}." .`);
  L.push('');
  // classes
  for (const c of a.classes) {
    L.push(`qsr:${localName(c.name)} a owl:Class ;`);
    L.push(`  rdfs:label "${esc(c.label || c.name)}" ;`);
    if (c.comment) L.push(`  rdfs:comment "${esc(c.comment)}" ;`);
    if (c.definition) L.push(`  skos:definition "${esc(c.definition)}" ;`);
    for (const syn of c.synonyms ?? []) L.push(`  skos:altLabel "${esc(syn)}" ;`);
    L.push(`  dcterms:type "${esc(c.role || 'entity')}" .`);
  }
  // subclass axioms
  for (const s of a.subclassAxioms ?? [])
    L.push(`qsr:${localName(s.child)} rdfs:subClassOf qsr:${localName(s.parent)} .`);
  L.push('');
  // datatype properties
  for (const d of a.datatypeProps) {
    const pid = `${localName(d.domainClass)}_${localName(d.property)}`;
    L.push(`qsr:${pid} a owl:DatatypeProperty ;`);
    L.push(`  rdfs:label "${esc(d.property)}" ;`);
    L.push(`  rdfs:domain qsr:${localName(d.domainClass)} ;`);
    if (d.role) L.push(`  dcterms:type "${esc(d.role)}${d.pii ? ',PII' : ''}" ;`);
    L.push(`  rdfs:range ${sqlToXsd(d.type)} .`);
  }
  L.push('');
  // object properties (confirmed relationships)
  for (const o of a.objectProps) {
    const from = o.from;
    const pid = `${localName(from)}_${localName(o.predicate)}_${localName(o.to)}`;
    L.push(`qsr:${pid} a owl:ObjectProperty ;`);
    L.push(`  rdfs:label "${esc(o.predicate)}" ;`);
    L.push(`  rdfs:domain qsr:${localName(from)} ;`);
    if (typeof o.confidence === 'number') L.push(`  dcterms:description "confidence ${o.confidence}" ;`);
    L.push(`  rdfs:range qsr:${localName(o.to)} .`);
  }
  return L.join('\n') + '\n';
}

// ---- JSON-LD serialization --------------------------------------------------
export function serializeJsonLd(a: OntologyArtifact): Record<string, unknown> {
  const ctx = {
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    owl: 'http://www.w3.org/2002/07/owl#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    skos: 'http://www.w3.org/2004/02/skos/core#',
    dcterms: 'http://purl.org/dc/terms/',
    qsr: a.iri,
  };
  const graph: Record<string, unknown>[] = [];
  graph.push({
    '@id': a.iri,
    '@type': 'owl:Ontology',
    'rdfs:label': `${a.productLabel} ontology`,
    'dcterms:created': a.generated_at,
    rules: (a.reasoningRules ?? []).map((r) => ({ id: r.id, if: r.if_conditions, then: r.then_conclusion })),
    seeAlso: (a.links ?? []).map((l) => l.url),
    servingObject: a.servingObject ?? null,
    servingViewPresent: Boolean(a.servingViewPresent),
  });
  for (const c of a.classes)
    graph.push({ '@id': `qsr:${localName(c.name)}`, '@type': 'owl:Class', 'rdfs:label': c.label || c.name, 'dcterms:type': c.role || 'entity' });
  for (const s of a.subclassAxioms ?? [])
    graph.push({ '@id': `qsr:${localName(s.child)}`, 'rdfs:subClassOf': { '@id': `qsr:${localName(s.parent)}` } });
  for (const d of a.datatypeProps)
    graph.push({ '@id': `qsr:${localName(d.domainClass)}_${localName(d.property)}`, '@type': 'owl:DatatypeProperty', 'rdfs:domain': { '@id': `qsr:${localName(d.domainClass)}` }, 'rdfs:range': { '@id': sqlToXsd(d.type) } });
  for (const o of a.objectProps)
    graph.push({ '@id': `qsr:${localName(o.from)}_${localName(o.predicate)}_${localName(o.to)}`, '@type': 'owl:ObjectProperty', 'rdfs:domain': { '@id': `qsr:${localName(o.from)}` }, 'rdfs:range': { '@id': `qsr:${localName(o.to)}` } });
  return { '@context': ctx, '@graph': graph };
}

// counts for storage metadata
export function artifactCounts(a: OntologyArtifact) {
  return { class_count: a.classes.length, objprop_count: a.objectProps.length };
}
