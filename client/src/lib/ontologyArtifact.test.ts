import { describe, it, expect } from 'vitest';
import { assembleArtifactInput } from './ontologyArtifact';
import { serializeTtl } from '../../../shared/ontologyArtifact';
import type { DerivedComponents } from './deriveComponents';

// minimal components fixture with the QSR ingredient class (only the fields
// assembleArtifactInput reads); cast to DerivedComponents for the test.
const components = {
  productName: 'sc_inventory_stockout',
  productLabel: 'Inventory & Stockout Risk',
  classes: [
    { class: 'jai_inventory_event', label: 'Inventory Event', role: 'fact', comment: 'fact' },
    { class: 'jai_dim_ingredient', label: 'Ingredient', role: 'dim', comment: 'dim' },
  ],
  mappings: [{ class: 'jai_inventory_event', property: 'days_of_supply', column: 'days_of_supply', type: 'double', role: 'measure', source: 'x' }],
  relationships: [
    { predicate: 'ingredient_id', label: 'x', from: ['jai_inventory_event'], to: 'jai_dim_ingredient', status: 'confirmed', origin: 'user' },
    { predicate: 'unconfirmed_id', label: 'y', from: ['jai_inventory_event'], to: 'jai_dim_restaurant', origin: 'heuristic' },
  ],
  ontologyGraph: { elements: [], nodes: {} },
} as unknown as DerivedComponents;

describe('assembleArtifactInput — QSR subclass taxonomy + confirmed-only object props', () => {
  const model = assembleArtifactInput({ components });

  it('emits Ingredient subclass axioms (Chicken/Produce/…) from the taxonomy', () => {
    const children = model.subclassAxioms?.map((s) => s.child) ?? [];
    expect(children).toContain('Chicken');
    expect(children).toContain('Produce');
    // parent is the ingredient class
    expect(model.subclassAxioms?.every((s) => s.parent === 'jai_dim_ingredient')).toBe(true);
    // subclasses are declared as classes too
    expect(model.classes.some((c) => c.name === 'Chicken')).toBe(true);
  });

  it('includes only CONFIRMED relationships as object properties', () => {
    expect(model.objectProps.map((o) => o.predicate)).toEqual(['ingredient_id']);
  });

  it('serializes the subclass axioms into TTL', () => {
    const ttl = serializeTtl(model);
    expect(ttl).toContain('qsr:Chicken rdfs:subClassOf qsr:jai_dim_ingredient');
  });
});
