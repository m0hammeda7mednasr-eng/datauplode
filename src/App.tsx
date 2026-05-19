import { BrowserRouter as Router, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { 
  LayoutDashboard, 
  PlusCircle, 
  Link as LinkIcon, 
  Settings, 
  RefreshCw, 
  AlertCircle, 
  History, 
  DollarSign,
  PackageSearch
} from 'lucide-react';
import { cn } from './lib/utils';

// Pages - to be created
import Dashboard from './pages/Dashboard';
import ImportProduct from './pages/ImportProduct';
import LinkedProducts from './pages/LinkedProducts';
import PricingRules from './pages/PricingRules';
import SyncJobs from './pages/SyncJobs';
import ManualReview from './pages/ManualReview';
import SettingsPage from './pages/Settings';
import ProductDetail from './pages/ProductDetail';
import SourcesPage from './pages/SourcesPage';

const queryClient = new QueryClient();

function SidebarItem({ to, icon: Icon, label, active, badge }: { to: string, icon: any, label: string, active?: boolean, badge?: string }) {
  return (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-3 px-6 py-3 transition-colors text-sm font-medium border-l-4 transition-all duration-200",
        active 
          ? "bg-sidebar-accent text-sidebar-foreground border-primary" 
          : "text-sidebar-muted border-transparent hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
      )}
    >
      <Icon className="h-4 w-4" />
      <span className="flex-1">{label}</span>
      {badge && (
        <span className="bg-amber-500 text-black text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
          {badge}
        </span>
      )}
    </Link>
  );
}

function TopBar({ breadcrumb }: { breadcrumb: string }) {
  return (
    <div className="h-16 bg-white border-b border-card-border flex items-center justify-between px-8 shrink-0">
      <div className="text-sm text-slate-500">
        Products / <span className="text-slate-900 font-semibold">{breadcrumb}</span>
      </div>
      <div className="flex items-center gap-4">
        <div className="text-[12px] text-slate-500">
          Queue Status: <span className="text-emerald-500 font-semibold">Healthy</span>
        </div>
        <div className="w-8 h-8 bg-slate-100 rounded-full border border-slate-200 overflow-hidden">
          <div className="w-full h-full flex items-center justify-center text-xs font-bold text-slate-400 uppercase">
            JD
          </div>
        </div>
      </div>
    </div>
  );
}

function Sidebar() {
  const location = useLocation();

  return (
    <aside className="w-60 bg-sidebar color-sidebar-foreground h-screen flex flex-col flex-shrink-0 sticky top-0 overflow-hidden">
      <div className="p-6 font-bold text-lg tracking-tight border-b border-sidebar-accent flex items-center gap-2.5 text-sidebar-foreground">
        <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center shadow-lg shadow-primary/20">
          <RefreshCw className="text-white h-5 w-5" />
        </div>
        <span className="uppercase tracking-tighter">Sync Engine</span>
      </div>

      <nav className="flex-1 mt-4">
        <SidebarItem to="/" icon={LayoutDashboard} label="Dashboard" active={location.pathname === '/'} />
        <SidebarItem to="/import" icon={PlusCircle} label="Import Product" active={location.pathname === '/import'} />
        <SidebarItem to="/products" icon={LinkIcon} label="Linked Products" active={location.pathname === '/products'} />
        <SidebarItem to="/review" icon={AlertCircle} label="Manual Review" active={location.pathname === '/review'} badge="12" />
        <SidebarItem to="/pricing" icon={DollarSign} label="Pricing Rules" active={location.pathname === '/pricing'} />
        <SidebarItem to="/sync-jobs" icon={History} label="Sync Jobs" active={location.pathname === '/sync-jobs'} />
      </nav>

      <div className="mb-4">
        <SidebarItem to="/sources" icon={PackageSearch} label="Sources" active={location.pathname === '/sources'} />
        <SidebarItem to="/settings" icon={Settings} label="Settings" active={location.pathname === '/settings'} />
      </div>
    </aside>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <div className="flex h-screen bg-background font-sans overflow-hidden">
          <Sidebar />
          <div className="flex-1 flex flex-col min-w-0">
            <Routes>
              <Route path="/" element={<><TopBar breadcrumb="Dashboard" /><main className="flex-1 p-8 overflow-y-auto"><Dashboard /></main></>} />
              <Route path="/import" element={<><TopBar breadcrumb="Import Product" /><main className="flex-1 p-8 overflow-y-auto"><ImportProduct /></main></>} />
              <Route path="/products" element={<><TopBar breadcrumb="Linked Products" /><main className="flex-1 p-8 overflow-y-auto"><LinkedProducts /></main></>} />
              <Route path="/products/:id" element={<><TopBar breadcrumb="Product Details" /><main className="flex-1 p-8 overflow-y-auto"><ProductDetail /></main></>} />
              <Route path="/pricing" element={<><TopBar breadcrumb="Pricing Rules" /><main className="flex-1 p-8 overflow-y-auto"><PricingRules /></main></>} />
              <Route path="/sync-jobs" element={<><TopBar breadcrumb="Sync Jobs" /><main className="flex-1 p-8 overflow-y-auto"><SyncJobs /></main></>} />
              <Route path="/review" element={<><TopBar breadcrumb="Manual Review" /><main className="flex-1 p-8 overflow-y-auto"><ManualReview /></main></>} />
              <Route path="/settings" element={<><TopBar breadcrumb="Settings" /><main className="flex-1 p-8 overflow-y-auto"><SettingsPage /></main></>} />
              <Route path="/sources" element={<><TopBar breadcrumb="Sources" /><main className="flex-1 p-8 overflow-y-auto"><SourcesPage /></main></>} />
              <Route path="/scraper/*" element={<Navigate to="/" replace />} />
              <Route path="/products/review/*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
        <Toaster position="top-right" richColors />
      </Router>
    </QueryClientProvider>
  );
}
