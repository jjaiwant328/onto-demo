// Compact text summary of a product's derived components — sent to the LLM
// endpoints (recommend-actions, copilot) as grounding context. Kept small.
import type { DerivedComponents } from './deriveComponents';

export function componentsSummary(c: DerivedComponents): string {
  const classes = c.classes.map((cl) => `${cl.label} (${cl.role}, ${cl.source_table})`).join('; ');
  const measures = c.measures
    .map((m) => `${m.measure} [${m.type}] = ${m.formula}`)
    .slice(0, 40)
    .join('\n');
  const rels = c.relationships.map((r) => `${r.from.join('|')} -${r.predicate}-> ${r.to}`).join('; ');
  return [
    `PRODUCT: ${c.productLabel} (${c.productName})${c.live ? ' [LIVE]' : ' [schema-derived]'}`,
    `KPIs: ${c.kpis.join(', ')}`,
    `CLASSES: ${classes}`,
    `RELATIONSHIPS: ${rels}`,
    `MEASURES/KPIS:\n${measures}`,
  ]
    .join('\n')
    .slice(0, 8000);
}
