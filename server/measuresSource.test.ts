// Unit tests for the runtime measures source. The parse must produce exactly
// the shape scripts/build-ontology-json.mjs bundles into
// client/src/data/ontology.json (consumed by client/src/lib/deriveComponents.ts)
// — the real-file parity test below pins that.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMeasuresYaml } from './measuresSource';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

describe('parseMeasuresYaml', () => {
  it('parses the real semantic_measures.yaml into the bundled shape', () => {
    const yaml = readFileSync(`${repoRoot}ontology/semantic_measures.yaml`, 'utf8');
    const bundled = JSON.parse(readFileSync(`${repoRoot}client/src/data/ontology.json`, 'utf8')) as {
      measures: unknown[];
    };
    expect(parseMeasuresYaml(yaml)).toEqual(bundled.measures);
  });

  it('folds multi-line scalars, strips comments, and parses flow lists', () => {
    const parsed = parseMeasuresYaml(
      [
        'version: 1  # header',
        'measures:',
        '  a_ratio:',
        '    type: derived',
        '    description: first line',
        '      continued here.',
        '    formula_sql: "sum(a) / nullif(sum(b), 0)"',
        '    unit: percent',
        '    additive: false',
        '    depends_on: [a, b]',
        'notes:',
        '  - ignored entirely',
      ].join('\n')
    );
    expect(parsed).toEqual([
      {
        measure: 'a_ratio',
        type: 'derived',
        unit: 'percent',
        formula: 'sum(a) / nullif(sum(b), 0)',
        description: 'first line continued here.',
        depends_on: ['a', 'b'],
      },
    ]);
  });

  it('throws on structural surprises and on a missing measures block', () => {
    expect(() => parseMeasuresYaml('measures:\n  ? unsupported')).toThrow(/unexpected measures entry/);
    expect(() => parseMeasuresYaml('version: 1\n')).toThrow(/no measures block/);
  });
});
