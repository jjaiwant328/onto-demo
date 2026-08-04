// Provenance presentation metadata — the shared answer to "how do we know this?".
//
// Kept separate from <ProvenanceBadge> so both a component and plain modules (and
// the About page's legend) can import the vocabulary without tripping React's
// fast-refresh rule about mixing component and non-component exports.
import { Database, Wand2, Sparkles, CheckCircle2, UserCheck } from 'lucide-react';
import type { Origin } from './deriveComponents';

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

export type ProvenanceSpec = {
  label: string;
  variant: BadgeVariant;
  icon: typeof Database;
  /** what this provenance means, in plain language, for a non-technical reader */
  meaning: string;
};

// Order of trust: observed > validated > user > llm > heuristic.
export const PROVENANCE_SPEC: Record<Origin, ProvenanceSpec> = {
  observed: {
    label: 'Observed',
    variant: 'secondary',
    icon: Database,
    meaning: 'Read directly from your schema — a table, column, type or comment that exists.',
  },
  heuristic: {
    label: 'Inferred',
    variant: 'outline',
    icon: Wand2,
    meaning: 'A guess from a name or type rule, not a fact about your data. Worth a human check.',
  },
  llm: {
    label: 'AI-proposed',
    variant: 'outline',
    icon: Sparkles,
    meaning:
      'Authored by the language model. Grounded in your schema, but not verified against your data.',
  },
  'llm-suggested': {
    label: 'AI-suggested',
    variant: 'outline',
    icon: Sparkles,
    meaning: 'Proposed by the model and awaiting your accept/reject decision.',
  },
  validated: {
    label: 'Validated',
    variant: 'default',
    icon: CheckCircle2,
    meaning: 'Measured against the warehouse — row counts and join hit-rates back this up.',
  },
  user: {
    label: 'Confirmed',
    variant: 'default',
    icon: UserCheck,
    meaning: 'A person asserted or confirmed this, overriding what was derived.',
  },
};

// Legend order for the About page: least to most evidence.
export const PROVENANCE_ORDER: Origin[] = [
  'observed',
  'heuristic',
  'llm',
  'llm-suggested',
  'validated',
  'user',
];

export function provenanceSpec(origin: Origin | undefined): ProvenanceSpec {
  // An unbadged claim would read as fact, so default to the weakest honest label.
  return PROVENANCE_SPEC[origin ?? 'heuristic'] ?? PROVENANCE_SPEC.heuristic;
}
export function provenanceLabel(origin: Origin): string {
  return provenanceSpec(origin).label;
}
export function provenanceMeaning(origin: Origin): string {
  return provenanceSpec(origin).meaning;
}
