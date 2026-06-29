import { createBrowserRouter, RouterProvider, NavLink, Outlet, Navigate } from 'react-router';
import { useState, useEffect } from 'react';
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
  Badge,
  useIsMobile,
} from '@databricks/appkit-ui/react';
import { Menu, Store } from 'lucide-react';
import { ProductProvider, useProduct } from './lib/product';
import { DataProducts } from './pages/DataProducts';
import { OntologyStudio } from './pages/OntologyStudio';
import { SemanticExplorer } from './pages/SemanticExplorer';
import { BusinessView } from './pages/BusinessView';
import { GraphExplorer } from './pages/GraphExplorer';
import { DataContract } from './pages/DataContract';
import { PrintProduct } from './pages/PrintProduct';
import { SchemaLoader } from './components/SchemaLoader';

const NAV = [
  { to: '/data-products', label: 'Data Products' },
  { to: '/ontology-studio', label: 'Ontology Studio' },
  { to: '/semantic-explorer', label: 'Semantic Explorer' },
  { to: '/graph-explorer', label: 'Graph Explorer' },
  { to: '/data-contract', label: 'Data Contract' },
  { to: '/business-view', label: 'Business View' },
];

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

function CatalogPicker() {
  const {
    domains,
    selectedDomain,
    setSelectedDomain,
    productsInDomain,
    selectedProduct,
    setSelectedProduct,
  } = useProduct();
  return (
    <div className="flex flex-col sm:flex-row gap-2">
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
                <div className="mb-4">
                  <CatalogPicker />
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
      <RouterProvider router={router} />
    </ProductProvider>
  );
}
