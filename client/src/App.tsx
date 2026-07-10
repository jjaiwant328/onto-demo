import { createBrowserRouter, RouterProvider, NavLink, Outlet, Navigate } from 'react-router';
import { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Checkbox,
  Badge,
  Switch,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  useIsMobile,
} from '@databricks/appkit-ui/react';
import {
  Menu,
  Store,
  Layers,
  Trash2,
  GitMerge,
  Split,
  Database as DatabaseIcon,
  Target,
  RotateCcw,
  Loader2,
  Settings,
  Save,
} from 'lucide-react';
import { ProductProvider, useProduct, ALL_SCOPE } from './lib/product';
import { ActionsContext, type ActionItem } from './lib/actions';
import { ControlTowerHome } from './pages/ControlTowerHome';
import { ActionInbox } from './pages/ActionInbox';
import { ScenarioImpact } from './pages/ScenarioImpact';
import { DataProducts } from './pages/DataProducts';
import { OntologyStudio } from './pages/OntologyStudio';
import { SemanticExplorer } from './pages/SemanticExplorer';
import { BusinessView } from './pages/BusinessView';
import { GraphExplorer } from './pages/GraphExplorer';
import { DataContract } from './pages/DataContract';
import { ActionCenter } from './pages/ActionCenter';
import { PrintProduct } from './pages/PrintProduct';
import { PrintActions } from './pages/PrintActions';
import { SchemaLoader } from './components/SchemaLoader';
import { Copilot } from './components/Copilot';

// always-on nav (ontology-focused)
// Business mode: the decision surfaces a supply-chain domain expert uses daily.
const NAV_BUSINESS = [
  { to: '/', label: 'Home' },
  { to: '/action-inbox', label: 'Action Inbox' },
  { to: '/scenario-impact', label: 'Scenario & Impact' },
  { to: '/action-center', label: 'Action Center' },
];
// Builder mode adds the technical curation / governance tabs.
const NAV_BUILDER = [
  { to: '/data-products', label: 'Data Products' },
  { to: '/ontology-studio', label: 'Ontology Studio' },
  { to: '/semantic-explorer', label: 'Semantic Explorer' },
  { to: '/graph-explorer', label: 'Graph Explorer' },
  { to: '/data-contract', label: 'Data Contract' },
];
// optional, gated by a settings toggle
const NAV_BUSINESS_VIEW = { to: '/business-view', label: 'Business View' };

// in-session action queue provider (shared by Action Center + Copilot).
// Reset when the active customer/schema changes so no customer's actions leak
// into another (isolation).
function ActionsProvider({ children }: { children: React.ReactNode }) {
  const { isolationKey } = useProduct();
  const [queue, setQueue] = useState<ActionItem[]>([]);
  const addAction = useCallback(
    (a: ActionItem) => setQueue((prev) => (prev.some((p) => p.id === a.id) ? prev : [a, ...prev])),
    []
  );
  useEffect(() => {
    setQueue([]);
  }, [isolationKey]);
  return (
    <ActionsContext.Provider value={{ queue, setQueue, addAction }}>
      {children}
    </ActionsContext.Provider>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

type NavLinkClassFn = (props: { isActive: boolean }) => string;

function NavLinks({
  className,
  linkClass,
  onClick,
}: {
  className?: string;
  linkClass: NavLinkClassFn;
  onClick?: () => void;
}) {
  const { mode, showBusinessView } = useProduct();
  const nav = [
    ...NAV_BUSINESS,
    ...(mode === 'builder' ? NAV_BUILDER : []),
    ...(showBusinessView ? [NAV_BUSINESS_VIEW] : []),
  ];
  return (
    <nav className={className}>
      {nav.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === '/'} className={linkClass} onClick={onClick}>
          {n.label}
        </NavLink>
      ))}
    </nav>
  );
}

// A titled group in the left control panel.
function PanelGroup({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}

// Schemas multi-select list (checkbox + trash), inline in the sidebar.
function SchemaList() {
  const {
    schemaEntries,
    selectedSchemaIds,
    toggleSchema,
    combineAll,
    combined,
    isBundledSchema,
    removeSchema,
    storeSchema,
  } = useProduct();
  const [storingId, setStoringId] = useState<string | null>(null);
  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between px-2 py-1.5 border-b">
        <span className="text-xs text-muted-foreground">
          {selectedSchemaIds.length === 1
            ? '1 selected'
            : `${selectedSchemaIds.length} selected${combined ? ' · combined' : ''}`}
        </span>
        {schemaEntries.length > 1 && (
          <Button variant="ghost" size="sm" className="h-6 gap-1 text-xs" onClick={combineAll}>
            <Layers className="h-3 w-3" /> Combine all
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-0.5 max-h-48 overflow-auto p-1">
        {schemaEntries.map((s) => {
          const bundled = isBundledSchema(s.id);
          const isCurated = s.id === 'fc_entdata_gold';
          // ephemeral = loaded this session but not yet in the durable store
          const ephemeral = !bundled && !s.savedId;
          const title = isCurated
            ? 'Delete Retailer — removes the live flagship (restore via Reset)'
            : bundled
              ? 'Delete built-in schema (restore via Reset)'
              : 'Delete schema';
          return (
            <div
              key={s.id}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted"
            >
              <Checkbox
                checked={selectedSchemaIds.includes(s.id)}
                onCheckedChange={() => toggleSchema(s.id)}
                aria-label={s.label}
              />
              <span className="truncate flex-1">{s.label}</span>
              {s.savedId && <Save className="h-3 w-3 text-emerald-600 shrink-0" aria-label="stored" />}
              {ephemeral && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 shrink-0"
                  title="Store durably (survives reloads)"
                  disabled={storingId === s.id}
                  onClick={async () => {
                    setStoringId(s.id);
                    await storeSchema(s.id);
                    setStoringId(null);
                  }}
                >
                  {storingId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5 text-primary" />}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 shrink-0"
                title={title}
                onClick={() => removeSchema(s.id)}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground px-2 py-1.5 border-t">
        Select 1 to view alone; 2+ to combine &amp; conform shared dimensions. Any schema (incl.
        built-ins) can be deleted; Reset restores them.
      </p>
    </div>
  );
}

// Domain control: dropdown + delete-current + combine (2+ domains) + un-merge.
function DomainControl() {
  const {
    domains,
    domainScope,
    domainScopeAll,
    selectedDomain,
    setSelectedDomain,
    deleteDomain,
    combineDomains,
    unmergeDomain,
  } = useProduct();
  const [combineOpen, setCombineOpen] = useState(false);
  const [toMerge, setToMerge] = useState<string[]>([]);

  // keep merge selection valid as the domain set changes
  useEffect(() => {
    setToMerge((prev) => prev.filter((n) => domains.some((d) => d.name === n)));
  }, [domains]);

  const toggleMerge = (name: string) =>
    setToMerge((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));

  // un-merge is offered only when the effective domain is itself a merge
  const isMerged = !domainScopeAll && Boolean(selectedDomain?.mergedFrom?.length);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Select value={domainScope} onValueChange={setSelectedDomain}>
          <SelectTrigger className="flex-1 min-w-0 h-9" aria-label="Domain">
            <SelectValue placeholder="Domain" className="truncate" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SCOPE}>All domains</SelectItem>
            {domains.map((d) => (
              <SelectItem key={d.name} value={d.name}>
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{d.label}</span>
                  {d.dataAvailable && (
                    <Badge variant="secondary" className="gap-1 text-[10px] px-1 py-0">
                      <DatabaseIcon className="h-2.5 w-2.5" /> Data Avlbl
                    </Badge>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isMerged && (
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            title="Un-merge — restore the original domains"
            onClick={() => selectedDomain && unmergeDomain(selectedDomain.name)}
          >
            <Split className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          disabled={domainScopeAll || !selectedDomain || domains.length <= 1}
          title={domainScopeAll ? 'Pick a single domain to delete it' : 'Delete this domain from the active catalog'}
          onClick={() => !domainScopeAll && selectedDomain && deleteDomain(selectedDomain.name)}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
        <Popover open={combineOpen} onOpenChange={setCombineOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 shrink-0"
              disabled={domains.length <= 1}
              title="Combine domains"
            >
              <GitMerge className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-2" align="start">
            <div className="text-xs font-medium text-muted-foreground px-1 pb-1">
              Combine domains ({toMerge.length} selected)
            </div>
            {/* single check mark to select every domain at once */}
            <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium hover:bg-muted cursor-pointer border-b mb-0.5">
              <Checkbox
                checked={domains.length > 0 && domains.every((d) => toMerge.includes(d.name))}
                onCheckedChange={(v) => setToMerge(v ? domains.map((d) => d.name) : [])}
              />
              <span>All domains</span>
            </label>
            <div className="flex flex-col gap-0.5 max-h-56 overflow-auto">
              {domains.map((d) => (
                <label
                  key={d.name}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted cursor-pointer"
                >
                  <Checkbox
                    checked={toMerge.includes(d.name)}
                    onCheckedChange={() => toggleMerge(d.name)}
                  />
                  <span className="truncate">{d.label}</span>
                </label>
              ))}
            </div>
            <Button
              size="sm"
              className="w-full mt-2 gap-1.5"
              disabled={toMerge.length < 2}
              onClick={() => {
                combineDomains(toMerge);
                setToMerge([]);
                setCombineOpen(false);
              }}
            >
              <GitMerge className="h-3.5 w-3.5" /> Merge {toMerge.length} domains
            </Button>
            <p className="text-[11px] text-muted-foreground px-1 pt-1">
              Union their products under one domain (de-duped). Session-only; Reset restores.
            </p>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

// The persistent left control panel content (shared by desktop rail + mobile sheet).
function ControlPanel() {
  const { productsInDomain, productScope, setSelectedProduct, resetSchemas, catalogLoading, llmRefining } =
    useProduct();

  return (
    <div className="flex flex-col gap-5">
      <PanelGroup icon={<DatabaseIcon className="h-3.5 w-3.5" />} title="Data source">
        <SchemaLoader />
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Schemas</span>
          <SchemaList />
        </div>
      </PanelGroup>

      <PanelGroup icon={<Target className="h-3.5 w-3.5" />} title="Scope">
        {/* schema-switch / catalog-regeneration indicators */}
        {(catalogLoading || llmRefining) && (
          <div className="flex flex-wrap items-center gap-2">
            {catalogLoading && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating catalog…
              </span>
            )}
            {llmRefining && (
              <Badge variant="outline" className="gap-1 text-[11px] font-normal animate-pulse">
                <Loader2 className="h-3 w-3 animate-spin" /> AI refining labels…
              </Badge>
            )}
          </div>
        )}
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Domain</span>
          <DomainControl />
        </div>
        <div className="space-y-1 min-w-0">
          <label className="text-xs text-muted-foreground" htmlFor="product-select">
            Product
          </label>
          <Select value={productScope} onValueChange={setSelectedProduct}>
            <SelectTrigger id="product-select" className="w-full h-9" aria-label="Data product">
              <SelectValue placeholder="Data product" className="truncate" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SCOPE}>All products</SelectItem>
              {productsInDomain.map((p) => (
                <SelectItem key={p.product_name} value={p.product_name}>
                  {p.display_name}
                  {p.live ? ' ●' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PanelGroup>

      <div className="space-y-2 border-t pt-4">
        <Copilot />
        <SettingsMenu />
        <Button
          variant="ghost"
          size="sm"
          className="w-full gap-1.5 text-muted-foreground"
          onClick={resetSchemas}
          title="Clear state and restore the built-in schemas"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset
        </Button>
      </div>
    </div>
  );
}

// Settings — extra nav visibility toggle (Business View). Action Center is part of
// Business mode; the technical tabs are revealed via the Business/Builder toggle.
function SettingsMenu() {
  const { showBusinessView, setShowBusinessView } = useProduct();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-start gap-1.5">
          <Settings className="h-4 w-4" /> Settings
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3 space-y-2.5" align="start">
        <div className="text-xs font-medium text-muted-foreground">Show sections</div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <Switch checked={showBusinessView} onCheckedChange={setShowBusinessView} />
          Business View
        </label>
        <p className="text-[11px] text-muted-foreground pt-1">
          Use the Business / Builder toggle (top bar) to show or hide the technical
          ontology tabs.
        </p>
      </PopoverContent>
    </Popover>
  );
}

// Business / Builder audience toggle. Business (default) shows only the decision
// surfaces; Builder reveals the technical curation tabs. Persisted via context.
function ModeToggle() {
  const { mode, setMode } = useProduct();
  return (
    <div className="flex items-center rounded-md border p-0.5 text-xs">
      {(['business', 'builder'] as const).map((m) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          className={`px-2 py-0.5 rounded capitalize transition-colors ${
            mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

// Toggle (top-right of the content area): when ON, in-section interactions
// (Graph Explorer node travel, Data Products row clicks) update the left-panel
// scope; OFF (default) = view-only. Persisted via context.
function ScopeSyncToggle() {
  const { syncScopeFromSections, setSyncScopeFromSections } = useProduct();
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
            <Switch
              checked={syncScopeFromSections}
              onCheckedChange={setSyncScopeFromSections}
              aria-label="Selections update scope"
            />
            <span className="hidden sm:inline">Selections update scope</span>
          </label>
        </TooltipTrigger>
        <TooltipContent>
          When on, clicking a product in a section (Data Products rows, Graph Explorer nodes) updates
          the left-panel Domain/Product scope. Off = view-only.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Layout() {
  const isMobile = useIsMobile();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false);
  }, [isMobile]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-4 md:px-6 py-3 flex items-center gap-3">
        <div className="md:hidden">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <Button variant="ghost" size="icon" onClick={() => setMobileNavOpen(true)}>
              <Menu className="h-5 w-5" />
              <span className="sr-only">Open controls</span>
            </Button>
            <SheetContent side="left" className="w-[340px] sm:w-[380px] overflow-y-auto">
              <SheetHeader>
                <SheetTitle>Controls</SheetTitle>
              </SheetHeader>
              <div className="mt-4">
                <ControlPanel />
              </div>
            </SheetContent>
          </Sheet>
        </div>
        <div className="flex items-center gap-2">
          <Store className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold text-foreground">Ontology-demo</h1>
          <Badge variant="outline" className="hidden sm:inline-flex">
            AppKit
          </Badge>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* persistent left control panel (desktop) */}
        <aside className="hidden md:block w-80 lg:w-96 shrink-0 border-r overflow-y-auto p-4">
          <ControlPanel />
        </aside>

        {/* main content: top section tabs + scope-sync toggle + routed page */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="border-b px-4 md:px-6 py-2 flex items-center gap-4">
            <div className="overflow-x-auto">
              <NavLinks className="flex gap-1 min-w-max" linkClass={navLinkClass} />
            </div>
            <div className="ml-auto shrink-0 flex items-center gap-3">
              <ModeToggle />
              <ScopeSyncToggle />
            </div>
          </div>
          <main className="flex-1 p-4 md:p-6 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>

      <footer className="border-t px-4 md:px-6 py-3 text-xs text-muted-foreground">
        Ontology-driven data products · OntoBricks + Ontos patterns · governed serving views in
        jai_ontos.demo_schema
      </footer>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <ControlTowerHome /> },
      { path: '/action-inbox', element: <ActionInbox /> },
      { path: '/scenario-impact', element: <ScenarioImpact /> },
      { path: '/data-products', element: <DataProducts /> },
      { path: '/ontology-studio', element: <OntologyStudio /> },
      { path: '/semantic-explorer', element: <SemanticExplorer /> },
      { path: '/graph-explorer', element: <GraphExplorer /> },
      { path: '/data-contract', element: <DataContract /> },
      { path: '/action-center', element: <ActionCenter /> },
      { path: '/business-view', element: <BusinessView /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
  // standalone print routes (no app chrome) for clean PDF export
  { path: '/print/actions', element: <PrintActions /> },
  { path: '/print/:productName', element: <PrintProduct /> },
]);

export default function App() {
  return (
    <ProductProvider>
      <ActionsProvider>
        <RouterProvider router={router} />
      </ActionsProvider>
    </ProductProvider>
  );
}
