// Converts the ontology source-of-truth artifacts in ontology/ into a single JSON
// file the React client bundles at build time. The TTL/YAML files remain the
// source of truth; this script is the AppKit-side equivalent of the legacy
// Streamlit app's ontology_service.py.
//
// Run: node scripts/build-ontology-json.mjs   (wired into npm prebuild/predev)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// js-yaml is a local build-time-only convenience and is intentionally NOT a
// package.json dependency (the Databricks Apps npm proxy doesn't carry it, and
// the generated ontology.json is committed). Install it ad hoc to regenerate:
//   npm i -D js-yaml && npm run ontology
let yaml;
try {
  yaml = (await import('js-yaml')).default;
} catch {
  console.warn(
    '[ontology] js-yaml not installed — keeping the committed client/src/data/ontology.json.\n' +
      '           To regenerate from ontology/*.yaml: npm i -D js-yaml && npm run ontology'
  );
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const ontoDir = path.join(repoRoot, 'ontology');
const outFile = path.join(repoRoot, 'client', 'src', 'data', 'ontology.json');

const read = (p) => fs.readFileSync(p, 'utf8');
const loadYaml = (p) => yaml.load(read(p)) ?? {};

// ---- TTL: classes + object properties (lightweight parse) -------------------
function parseTtl(ttl) {
  const classes = [];
  const classRe = /rt:(\w+)\s+a\s+owl:Class\s*;([\s\S]*?)\./g;
  let m;
  while ((m = classRe.exec(ttl))) {
    const name = m[1];
    const body = m[2];
    const label = (body.match(/rdfs:label\s+"([^"]+)"/) || [])[1] || name;
    const comment = (body.match(/rdfs:comment\s+"([^"]+)"/) || [])[1] || '';
    classes.push({ name, label, comment });
  }

  const relationships = [];
  const relRe = /rt:(\w+)\s+a\s+owl:ObjectProperty\s*;([\s\S]*?)\./g;
  while ((m = relRe.exec(ttl))) {
    const predicate = m[1];
    const body = m[2];
    const label = (body.match(/rdfs:label\s+"([^"]+)"/) || [])[1] || predicate;
    // domain may be a single class or an owl:unionOf (...)
    const domSingle = body.match(/rdfs:domain\s+rt:(\w+)/);
    const domUnion = body.match(/rdfs:domain\s+\[\s*owl:unionOf\s*\(([^)]+)\)/);
    let from;
    if (domSingle) {
      from = [domSingle[1]];
    } else if (domUnion) {
      from = [...domUnion[1].matchAll(/rt:(\w+)/g)].map((x) => x[1]);
    } else {
      from = ['(union)'];
    }
    const rng = body.match(/rdfs:range\s+rt:(\w+)/);
    relationships.push({ predicate, label, from, to: rng ? rng[1] : '?' });
  }
  return { classes, relationships };
}

// ---- source_mapping.yaml: business -> physical mappings ---------------------
function flattenMappings(mapping) {
  const out = [];
  const classes = mapping.classes || {};
  const classMeta = {};
  for (const [cname, cfg] of Object.entries(classes)) {
    const src = cfg.source_table || '(derived)';
    classMeta[cname] = {
      grain: cfg.grain || (cfg.derived ? 'derived' : '—'),
      source_table: src,
      derived: Boolean(cfg.derived),
    };
    if (cfg.key && typeof cfg.key === 'object') {
      out.push({ class: cname, property: cfg.key.ontology, source: src, column: cfg.key.column, role: 'key' });
    }
    for (const [prop, col] of Object.entries(cfg.keys || {})) {
      out.push({ class: cname, property: prop, source: src, column: col, role: 'key' });
    }
    for (const [prop, col] of Object.entries(cfg.columns || {})) {
      out.push({ class: cname, property: prop, source: src, column: col, role: 'attribute' });
    }
    for (const [prop, spec] of Object.entries(cfg.measures || {})) {
      const col = spec && typeof spec === 'object' ? spec.column ?? JSON.stringify(spec) : spec;
      out.push({ class: cname, property: prop, source: src, column: String(col), role: 'measure' });
    }
  }
  return { mappings: out, classMeta };
}

// ---- semantic_measures.yaml -------------------------------------------------
function flattenMeasures(doc) {
  const out = [];
  for (const [name, m] of Object.entries(doc.measures || {})) {
    out.push({
      measure: name,
      type: m.type,
      unit: m.unit,
      formula: m.formula_sql,
      description: (m.description || '').trim(),
      depends_on: m.depends_on || [],
    });
  }
  return out;
}

const ttl = read(path.join(ontoDir, 'retail_traffic_labor.ttl'));
const mapping = loadYaml(path.join(ontoDir, 'source_mapping.yaml'));
const measuresDoc = loadYaml(path.join(ontoDir, 'semantic_measures.yaml'));

const { classes: ttlClasses, relationships } = parseTtl(ttl);
const { mappings, classMeta } = flattenMappings(mapping);

// Merge TTL class labels with mapping grain/source info.
const classes = ttlClasses.map((c) => ({
  class: c.name,
  label: c.label,
  comment: c.comment,
  grain: classMeta[c.name]?.grain ?? '—',
  source_table: classMeta[c.name]?.source_table ?? '(derived)',
  derived: classMeta[c.name]?.derived ?? false,
}));

const payload = {
  generatedAt: new Date().toISOString(),
  ontologyLabel: 'Retail Store Traffic & Labor Efficiency',
  classes,
  relationships,
  mappings,
  measures: flattenMeasures(measuresDoc),
  assumptions: mapping.assumptions || {},
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n');
console.log(
  `ontology.json written: ${classes.length} classes, ${relationships.length} relationships, ` +
    `${mappings.length} mappings, ${payload.measures.length} measures`
);
