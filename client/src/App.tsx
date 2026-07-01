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
import { Menu, Store, Layers } from 'lucide-react';
import { ProductProvider, useProduct } from './lib/product';
import type { SchemaEntry } from './lib/combineSchemas';
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

// in-session action queue provider (shared by Action Center + Copilot)
function ActionsProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<ActionItem[]>([]);
  const addAction = useCallback(
    (a: ActionItem) => setQueue((prev) => (prev.some((p) => p.id === a.id) ? prev : [a, ...prev])),
    []
  );
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

const mobileNavLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
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

// Multi-select schema menu (PopoverContent): one = view alone, 2+ = combined.
function SheetlessSchemaMenu({
  schemaEntries,
  selectedSchemaIds,
  toggleSchema,
  combineAll,
}: {
  schemaEntries: SchemaEntry[];
  selectedSchemaIds: string[];
  toggleSchema: (id: string) => void;
  combineAll: () => void;
}) {
  return (
    <PopoverContent className="w-72 p-2" align="start">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-medium text-muted-foreground">
          Schemas ({schemaEntries.length})
        </span>
        {schemaEntries.length > 1 && (
          <Button variant="ghost" size="sm" className="h-6 gap-1 text-xs" onClick={combineAll}>
            <Layers className="h-3 w-3" /> Combine all
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-0.5 max-h-72 overflow-auto">
        {schemaEntries.map((s) => (
          <label
            key={s.id}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted cursor-pointer"
          >
            <Checkbox
              checked={selectedSchemaIds.includes(s.id)}
              onCheckedChange={() => toggleSchema(s.id)}
            />
            <span className="truncate">{s.label}</span>
          </label>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground px-1 pt-1">
        Select 1 to view alone; 2+ to combine &amp; conform shared dimensions.
      </p>
    </PopoverContent>
  );
}

function CustomerSchemaPicker() {
  const {
    customers,
    customerId,
    setCustomer,
    schemaEntries,
    selectedSchemaIds,
    toggleSchema,
    combineAll,
    combined,
  } = useProduct();
  const [open, setOpen] = useState(false);
  const schemaBtn =
    selectedSchemaIds.length === 1
      ? (schemaEntries.find((s) => s.id === selectedSchemaIds[0])?.label ?? '1 schema')
      : `${selectedSchemaIds.length} schemas${combined ? ' · combined' : ''}`;

  return (
    <div className="flex flex-col sm:flex-row gap-2">
      {/* Customer */}
      <Select value={customerId} onValueChange={setCustomer}>
        <SelectTrigger className="w-44" aria-label="Customer">
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

      {/* Schema multi-select */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="w-52 justify-between font-normal">
            <span className="truncate">{schemaBtn}</span>
            <span className="text-muted-foreground text-xs ml-1">▾</span>
          </Button>
        </PopoverTrigger>
        <SheetlessSchemaMenu
          schemaEntries={schemaEntries}
          selectedSchemaIds={selectedSchemaIds}
          toggleSchema={toggleSchema}
          combineAll={combineAll}
        />
      </Popover>
    </div>
  );
}

function CatalogPicker() {
  const { domains, selectedDomain, setSelectedDomain, productsInDomain, selectedProduct, setSelectedProduct } =
    useProduct();
  return (
    <div className="flex flex-col sm:flex-row gap-2">
      <CustomerSchemaPicker />
      {selectedDomain && (
        <Select value={selectedDomain.name} onValueChange={setSelectedDomain}>
          <SelectTrigger className="w-52" aria-label="Domain">
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
      {selectedProduct && (
        <Select value={selectedProduct.product_name} onValueChange={setSelectedProduct}>
          <SelectTrigger className="w-64" aria-label="Data product">
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
      )}
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
      <header className="border-b px-4 md:px-6 py-3 flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Store className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold text-foreground">RT_onto_demo</h1>
          <Badge variant="outline" className="hidden sm:inline-flex">
            AppKit
          </Badge>
        </div>
        <NavLinks className="hidden md:flex gap-1" linkClass={navLinkClass} />
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden md:block">
            <Copilot />
          </div>
          <div className="hidden md:block">
            <SchemaLoader />
          </div>
          <div className="hidden md:block">
            <CatalogPicker />
          </div>
          <div className="md:hidden">
            <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <Button variant="ghost" size="icon" onClick={() => setMobileNavOpen(true)}>
                <Menu className="h-5 w-5" />
                <span className="sr-only">Open navigation</span>
              </Button>
              <SheetContent side="left">
                <SheetHeader>
                  <SheetTitle>Navigation</SheetTitle>
                </SheetHeader>
                <div className="mt-4 mb-2">
                  <SchemaLoader />
                </div>
                <div className="mb-2">
                  <CatalogPicker />
                </div>
                <div className="mb-4">
                  <Copilot />
                </div>
                <NavLinks
                  className="flex flex-col gap-1"
                  linkClass={mobileNavLinkClass}
                  onClick={() => setMobileNavOpen(false)}
                />
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-6">
        <Outlet />
      </main>

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
