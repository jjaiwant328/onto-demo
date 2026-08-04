import { describe, it, expect } from 'vitest';
import { buildArtifactModel, serializeTtl, serializeJsonLd, sqlToXsd, type ArtifactInput } from './ontologyArtifact';

const input: ArtifactInput = {
  product: 'jai_inventory_event',
  productLabel: 'Inventory & Stockout Risk',
  classes: [
    { name: 'jai_inventory_event', label: 'Inventory Event', role: 'fact', comment: 'fact' },
    { name: 'jai_dim_restaurant', label: 'Restaurant', role: 'dim', definition: 'A QSR restaurant' },
  ],
  datatypeProps: [
    { domainClass: 'jai_inventory_event', property: 'days_of_supply', type: 'double', role: 'measure' },
    { domainClass: 'jai_inventory_event', property: 'restaurant_id', type: 'string', role: 'key' },
  ],
  objectProps: [
    { from: 'jai_inventory_event', to: 'jai_dim_restaurant', predicate: 'restaurant_id', confidence: 1 },
  ],
  subclassAxioms: [{ child: 'Chicken', parent: 'Ingredient' }],
  reasoningRules: [
    { id: 'RR1', name: 'Heat wave', if_conditions: ['temp > 90'], then_conclusion: 'beverage demand up' },
  ],
  links: [{ link_type: 'dashboard', url: 'https://example/dash', label: 'CC' }],
  servingObject: 'jai_ontos.demo_schema.jai_x_serving',
  servingViewPresent: true,
};

describe('ontology artifact serializer', () => {
  it('sqlToXsd maps common types', () => {
    expect(sqlToXsd('bigint')).toBe('xsd:integer');
    expect(sqlToXsd('double')).toBe('xsd:decimal');
    expect(sqlToXsd('boolean')).toBe('xsd:boolean');
    expect(sqlToXsd('date')).toBe('xsd:date');
    expect(sqlToXsd('string')).toBe('xsd:string');
  });

  it('serializeTtl emits classes, datatype + object properties, subclass, rule, link', () => {
    const ttl = serializeTtl(buildArtifactModel(input));
    expect(ttl).toContain('@prefix owl:');
    expect(ttl).toContain('qsr:jai_inventory_event a owl:Class');
    expect(ttl).toContain('qsr:jai_dim_restaurant a owl:Class');
    expect(ttl).toContain('a owl:DatatypeProperty');
    expect(ttl).toContain('a owl:ObjectProperty');
    expect(ttl).toContain('rdfs:range qsr:jai_dim_restaurant');
    expect(ttl).toContain('qsr:Chicken rdfs:subClassOf qsr:Ingredient');
    expect(ttl).toContain('RULE RR1');
    expect(ttl).toContain('rdfs:seeAlso <https://example/dash>');
  });

  it('serializeJsonLd produces a @graph with the classes + object property', () => {
    const jsonld = serializeJsonLd(buildArtifactModel(input)) as { '@graph': { '@type'?: string }[] };
    const types = jsonld['@graph'].map((n) => n['@type']).filter(Boolean);
    expect(types).toContain('owl:Class');
    expect(types).toContain('owl:DatatypeProperty');
    expect(types).toContain('owl:ObjectProperty');
  });
});
