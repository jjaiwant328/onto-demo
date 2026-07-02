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
  useIsMobile,
} from '@databricks/appkit-ui/react';
import { Menu, Store, Layers, Trash2, GitMerge, Database as DatabaseIcon, Target, RotateCcw } from 'lucide-react';
import { ProductProvider, useProduct } from './lib/product';
import { ActionsContext, type ActionItem } from './lib/actions';
import { DataProducts } from './pages/DataProducts';
import { OntologyStudio } from './pages/OntologyStudio';
import { SemanticExplorer } from './pages/SemanticExplorer';
import { BusinessView } from './pages/BusinessView';
import { GraphExplorer } from './pages/GraphExplorer';
import { DataContract } from './pages/DataContract';
import { ActionCenter } from './pages/ActionCenter';
import { PrintProduct } from './pages/PrintProduct';
import { SchemaLoader } from './components/SchemaLoader';
import { Copilot } from './components/Copilot';

const NAV = [
  { to: '/data-products', label: 'Data Products' },
  { to: '/ontology-studio', label: 'Ontology Studio' },
  { to: '/semantic-explorer', label: 'Semantic Explorer' },
  { to: '/graph-explorer', label: 'Graph Explorer' },
  { to: '/data-contract', label: 'Data Contract' },
  { to: '/action-center', label: 'Action Center' },
  { to: '/business-view', label: 'Business View' },
];

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
  return (
    <nav className={className}>
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} className={linkClass} onClick={onClick}>
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
    customerId,
    schemaEntries,
    selectedSchemaIds,
    toggleSchema,
    combineAll,
    combined,
    isBundledSchema,
    removeSchema,
  } = useProduct();
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
          const bundled = isBundledSchema(customerId, s.id);
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
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 shrink-0"
                disabled={bundled}
                title={bundled ? 'Bundled schema — not removable' : 'Delete schema'}
                onClick={() => removeSchema(customerId, s.id)}
              >
                <Trash2 className={`h-3.5 w-3.5 ${bundled ? 'opacity-30' : 'text-destructive'}`} />
              </Button>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground px-2 py-1.5 border-t">
        Select 1 to view alone; 2+ to combine &amp; conform shared dimensions.
      </p>
    </div>
  );
}

// Domain control: dropdown + delete-current + combine (2+ domains).
function DomainControl() {
  const { domains, selectedDomain, setSelectedDomain, deleteDomain, combineDomains } = useProduct();
  const [combineOpen, setCombineOpen] = useState(false);
  const [toMerge, setToMerge] = useState<string[]>([]);

  // keep merge selection valid as the domain set changes
  useEffect(() => {
    setToMerge((prev) => prev.filter((n) => domains.some((d) => d.name === n)));
  }, [domains]);

  const toggleMerge = (name: string) =>
    setToMerge((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        {selectedDomain && (
          <Select value={selectedDomain.name} onValueChange={setSelectedDomain}>
            <SelectTrigger className="flex-1 h-9" aria-label="Domain">
              <SelectValue placeholder="Domain" />
            </SelectTrigger>
            <SelectContent>
              {domains.map((d) => (
                <SelectItem key={d.name} value={d.name}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          disabled={!selectedDomain || domains.length <= 1}
          title="Delete this domain from the active catalog"
          onClick={() => selectedDomain && deleteDomain(selectedDomain.name)}
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
  const {
    customers,
    customerId,
    setCustomer,
    productsInDomain,
    selectedProduct,
    setSelectedProduct,
    resetCustomers,
  } = useProduct();

  return (
    <div className="flex flex-col gap-5">
      <PanelGroup icon={<DatabaseIcon className="h-3.5 w-3.5" />} title="Data source">
        <SchemaLoader />
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="customer-select">
            Customer
          </label>
          <Select value={customerId} onValueChange={setCustomer}>
            <SelectTrigger id="customer-select" className="w-full h-9" aria-label="Customer">
              <SelectValue placeholder="Customer" />
            </SelectTrigger>
            <SelectContent>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Schemas</span>
          <SchemaList />
        </div>
      </PanelGroup>

      <PanelGroup icon={<Target className="h-3.5 w-3.5" />} title="Scope">
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Domain</span>
          <DomainControl />
        </div>
        {selectedProduct && (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="product-select">
              Product
            </label>
            <Select value={selectedProduct.product_name} onValueChange={setSelectedProduct}>
              <SelectTrigger id="product-select" className="w-full h-9" aria-label="Data product">
                <SelectValue placeholder="Data product" />
              </SelectTrigger>
              <SelectContent>
                {productsInDomain.map((p) => (
                  <SelectItem key={p.product_name} value={p.product_name}>
                    {p.display_name}
                    {p.live ? ' ●' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </PanelGroup>

      <div className="space-y-2 border-t pt-4">
        <Copilot />
        <Button
          variant="ghost"
          size="sm"
          className="w-full gap-1.5 text-muted-foreground"
          onClick={resetCustomers}
          title="Clear state and restore Retailer + QSR"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset
        </Button>
      </div>
    </div>
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
            <SheetContent side="left" className="w-[320px] overflow-y-auto">
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
          <h1 className="text-lg font-semibold text-foreground">RT_onto_demo</h1>
          <Badge variant="outline" className="hidden sm:inline-flex">
            AppKit
          </Badge>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* persistent left control panel (desktop) */}
        <aside className="hidden md:block w-72 shrink-0 border-r overflow-y-auto p-4">
          <ControlPanel />
        </aside>

        {/* main content: top section tabs + routed page */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="border-b px-4 md:px-6 py-2 overflow-x-auto">
            <NavLinks className="flex gap-1 min-w-max" linkClass={navLinkClass} />
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
      { index: true, element: <Navigate to="/data-products" replace /> },
      { path: '/data-products', element: <DataProducts /> },
      { path: '/ontology-studio', element: <OntologyStudio /> },
      { path: '/semantic-explorer', element: <SemanticExplorer /> },
      { path: '/graph-explorer', element: <GraphExplorer /> },
      { path: '/data-contract', element: <DataContract /> },
      { path: '/action-center', element: <ActionCenter /> },
      { path: '/business-view', element: <BusinessView /> },
      { path: '*', element: <Navigate to="/data-products" replace /> },
    ],
  },
  // standalone print route (no app chrome) for clean PDF export
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
