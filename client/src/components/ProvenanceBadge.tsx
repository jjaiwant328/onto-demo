// ProvenanceBadge — one shared answer to "how do we know this?", so a fact read
// from the schema never looks like a regex guess or a model suggestion.
//
// The pipeline that builds Domains → Data Products → Data Contracts mixes four
// very different kinds of claim (see /about). Rendering them with equal visual
// weight is what makes a derived catalog untrustworthy: a domain expert spots one
// wrong table and discounts everything. This badge makes the distinction legible,
// and its `evidence` tooltip always answers *why*.
//
// The vocabulary itself lives in lib/provenance.ts so non-component modules can
// use it too.
import {
  Badge,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@databricks/appkit-ui/react';
import type { Origin } from '../lib/deriveComponents';
import { provenanceSpec } from '../lib/provenance';

export function ProvenanceBadge({
  origin,
  evidence,
  className,
  showIcon = true,
}: {
  origin: Origin | undefined;
  /** why we believe it — the specific rule that fired, or the measurement taken */
  evidence?: string;
  className?: string;
  showIcon?: boolean;
}) {
  const spec = provenanceSpec(origin);
  const Icon = spec.icon;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant={spec.variant}
            className={`gap-1 text-[10px] font-normal cursor-help ${className ?? ''}`}
          >
            {showIcon && <Icon className="h-3 w-3" />}
            {spec.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <span className="font-medium">{spec.label}</span> — {spec.meaning}
          {evidence && (
            <>
              <br />
              <span className="text-muted-foreground">Why: {evidence}</span>
            </>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
