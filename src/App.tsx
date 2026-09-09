import type { ReactNode } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import {
  LayoutDashboard,
  Settings,
  RefreshCw,
  DollarSign,
  PackageSearch,
} from 'lucide-react';
import { cn } from './lib/utils';

import LinkedProducts from './pages/LinkedProducts';
import PricingRules from './pages/PricingRules';
import SettingsPage from './pages/Settings';
import ProductDetail from './pages/ProductDetail';
import SourcesPage from './pages/SourcesPage';
import CatalogMobileMonitor from './components/CatalogMobileMonitor';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (failureCount, error: any) => {
        const status = Number(error?.response?.status || 0);
        if (status >= 400 && status < 500) return false;
        return failureCount < 1;
      },
    },
  },
});

function SidebarItem({ to, icon: Icon, label, active, badge }: { to: string, icon: any, label: string, active?: boolean, badge?: string }) {
  return (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-3 border-l-4 px-6 py-3 text-sm font-medium transition-all duration-200',
        active
          ? 'border-primary bg-sidebar-accent text-sidebar-foreground'
          : 'border-transparent text-sidebar-muted hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
      )}
    >
      <Icon className="h-4 w-4" />
      <span className="flex-1">{label}</span>
      {badge && (
        <span className="min-w-[20px] rounded-full bg-amber-500 px-1.5 py-0.5 text-center text-[10px] font-bold text-black">
          {badge}
        </span>
      )}
    </Link>
  );
}

function TopBar({ breadcrumb }: { breadcrumb: string }) {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between border-b border-card-border bg-white px-4 md:h-16 md:px-8">
      <div className="min-w-0">
        <div className="hidden text-sm text-slate-500 md:block">
          Products / <span className="font-semibold text-slate-900">{breadcrumb}</span>
        </div>
        <div className="truncate text-sm font-black text-slate-900 md:hidden">{breadcrumb}</div>
      </div>
      <div className="flex items-center gap-3 md:gap-4">
        <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 md:text-[12px]">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="hidden sm:inline">Queue</span>
          <span className="text-emerald-600">Healthy</span>
        </div>
        <div className="hidden h-8 w-8 overflow-hidden rounded-full border border-slate-200 bg-slate-100 sm:flex">
          <div className="flex h-full w-full items-center justify-center text-xs font-bold uppercase text-slate-400">JD</div>
        </div>
      </div>
    </div>
  );
}

function Sidebar() {
  const location = useLocation();

  return (
    <aside className="sticky top-0 hidden h-screen w-60 flex-shrink-0 flex-col overflow-hidden bg-sidebar color-sidebar-foreground md:flex">
      <div className="flex items-center gap-2.5 border-b border-sidebar-accent p-6 text-lg font-bold tracking-tight text-sidebar-foreground">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary shadow-lg shadow-primary/20">
          <RefreshCw className="h-5 w-5 text-white" />
        </div>
        <span className="uppercase tracking-tighter">Sync Engine</span>
      </div>

      <nav className="mt-4 flex-1">
        <SidebarItem to="/products" icon={LayoutDashboard} label="Catalog Sync" active={location.pathname === '/' || location.pathname.startsWith('/products')} />
        <SidebarItem to="/pricing" icon={DollarSign} label="Pricing Rules" active={location.pathname === '/pricing'} />
      </nav>

      <div className="mb-4">
        <SidebarItem to="/sources" icon={PackageSearch} label="Sources" active={location.pathname === '/sources'} />
        <SidebarItem to="/settings" icon={Settings} label="Settings" active={location.pathname === '/settings'} />
      </div>
    </aside>
  );
}

function MobileNav() {
  const location = useLocation();
  const items = [
    { to: '/products', label: 'Catalog', icon: LayoutDashboard, active: location.pathname === '/' || location.pathname.startsWith('/products') },
    { to: '/pricing', label: 'Pricing', icon: DollarSign, active: location.pathname === '/pricing' },
    { to: '/sources', label: 'Sources', icon: PackageSearch, active: location.pathname === '/sources' },
    { to: '/settings', label: 'Settings', icon: Settings, active: location.pathname === '/settings' },
  ];

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-4 border-t border-slate-200 bg-white/95 px-1 pt-1.5 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur md:hidden [padding-bottom:max(0.4rem,env(safe-area-inset-bottom))]">
      {items.map(({ to, label, icon: Icon, active }) => (
        <Link
          key={to}
          to={to}
          className={cn(
            'flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10px] font-black transition-colors',
            active ? 'bg-slate-950 text-white' : 'text-slate-500',
          )}
        >
          <Icon className="h-4 w-4" />
          <span className="truncate">{label}</span>
        </Link>
      ))}
    </nav>
  );
}

function PageMain({ children }: { children: ReactNode }) {
  return (
    <main className="flex-1 overflow-x-hidden overflow-y-auto p-3 pb-24 sm:p-4 sm:pb-24 md:p-8 md:pb-8">
      {children}
    </main>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <div className="flex h-[100dvh] overflow-hidden bg-background font-sans">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <Routes>
              <Route path="/" element={<Navigate to="/products" replace />} />
              <Route path="/products" element={<><TopBar breadcrumb="Catalog Sync" /><CatalogMobileMonitor /><PageMain><LinkedProducts /></PageMain></>} />
              <Route path="/products/:id" element={<><TopBar breadcrumb="Product Details" /><PageMain><ProductDetail /></PageMain></>} />
              <Route path="/pricing" element={<><TopBar breadcrumb="Pricing Rules" /><PageMain><PricingRules /></PageMain></>} />
              <Route path="/settings" element={<><TopBar breadcrumb="Settings" /><PageMain><SettingsPage /></PageMain></>} />
              <Route path="/sources" element={<><TopBar breadcrumb="Sources" /><PageMain><SourcesPage /></PageMain></>} />
              <Route path="/import" element={<Navigate to="/products" replace />} />
              <Route path="/excel-sheet" element={<Navigate to="/products" replace />} />
              <Route path="/default-variants" element={<Navigate to="/products" replace />} />
              <Route path="/sync-jobs" element={<Navigate to="/products" replace />} />
              <Route path="/review" element={<Navigate to="/products" replace />} />
              <Route path="/scraper/*" element={<Navigate to="/" replace />} />
              <Route path="/products/review/*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
        <MobileNav />
        <Toaster position="top-right" richColors />
      </Router>
    </QueryClientProvider>
  );
}
