// Lightweight skeleton placeholder shown while the active catalog is (re)building
// after a schema/selection switch (see product.catalogLoading). Reused by the
// generated tabs (Data Products, Ontology Studio, Semantic Explorer, Graph
// Explorer) so the schema-switch lag reads as "loading" rather than blank/stale.
import { Skeleton } from '@databricks/appkit-ui/react';

export function CatalogLoadingSkeleton({ label = 'Generating catalog…' }: { label?: string }) {
  return (
    <div className="space-y-6 max-w-6xl" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <span className="sr-only">{label}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-lg" />
    </div>
  );
}
