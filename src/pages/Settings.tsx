import { useState, useEffect } from 'react';
import { 
  Settings as SettingsIcon, 
  ShoppingBag, 
  ShieldCheck, 
  Bell, 
  Zap,
  Globe,
  Database,
  Link,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Copy
} from 'lucide-react';
import { cn } from '../lib/utils';
import { toast } from 'sonner';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { apiErrorMessage } from '../lib/api';

const SCOPES = [
  'read_products', 'write_products', 
  'read_inventory', 'write_inventory',
  'read_files', 'write_files',
  'read_publications', 'write_publications'
];

export default function Settings() {
  const [activeTab, setActiveTab] = useState('shopify');
  const queryClient = useQueryClient();

  const { data: config, isLoading: isLoadingConfig } = useQuery({
    queryKey: ['shopify-config'],
    queryFn: async () => {
      const { data } = await axios.get('/api/settings/shopify');
      return data;
    }
  });

  const saveMutation = useMutation({
    mutationFn: async (data: any) => axios.post('/api/settings/shopify', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shopify-config'] });
      toast.success('Shopify credentials saved');
    },
    onError: (err: any) => {
      toast.error(apiErrorMessage(err, 'Failed to save credentials'));
    }
  });

  const connectMutation = useMutation({
    mutationFn: async () => {
      const { data } = await axios.post('/api/shopify/connect');
      window.location.href = data.url;
    },
    onError: (err: any) => {
      toast.error(apiErrorMessage(err, 'Failed to initiate connection'));
    }
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => axios.post('/api/shopify/disconnect'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shopify-config'] });
      toast.success('Store disconnected');
    }
  });

  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const canConnect = Boolean(
    config?.shopDomain &&
    config?.clientId &&
    config?.hasClientSecret &&
    !config?.isConnected
  );
  
  useEffect(() => {
    if (config?.scopes) {
      setSelectedScopes([...new Set([...SCOPES, ...config.scopes])]);
    } else if (!config) {
      setSelectedScopes(SCOPES);
    }
  }, [config]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');

    if (connected === 'true') {
      toast.success('Shopify store connected');
      window.history.replaceState(null, '', window.location.pathname);
    } else if (connected === 'false') {
      toast.error('Shopify connection failed');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const testMutation = useMutation({
    mutationFn: async (shopDomain: string) => axios.post('/api/settings/shopify/test', { shopDomain }),
    onSuccess: (res) => {
      toast.success(res.data.message);
    },
    onError: (err: any) => {
      toast.error(apiErrorMessage(err, 'Test failed'));
    }
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const data = {
      shopDomain: formData.get('shopDomain'),
      clientId: formData.get('clientId'),
      clientSecret: formData.get('clientSecret'),
      scopes: selectedScopes
    };
    const normalizedShopDomain = data.shopDomain
      ?.toString()
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');

    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalizedShopDomain || '')) {
      toast.error('Shop domain must end with .myshopify.com');
      return;
    }

    saveMutation.mutate({ ...data, shopDomain: normalizedShopDomain });
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">Global Configuration</h1>
        <p className="text-slate-500 font-medium">Control synchronization behavior and API credentials.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-8">
        <nav className="space-y-1">
          <SettingsTab active={activeTab === 'shopify'} onClick={() => setActiveTab('shopify')} label="Shopify Integration" icon={SettingsIcon} />
          <SettingsTab active={activeTab === 'scrapers'} onClick={() => setActiveTab('scrapers')} label="Scraper Tuning" icon={Globe} />
          <SettingsTab active={activeTab === 'notifications'} onClick={() => setActiveTab('notifications')} label="Alerts & Logs" icon={Bell} />
          <SettingsTab active={activeTab === 'security'} onClick={() => setActiveTab('security')} label="System Security" icon={ShieldCheck} />
        </nav>

        <div className="bg-white rounded-2xl border border-card-border shadow-sm overflow-hidden min-h-[500px]">
          {activeTab === 'shopify' && (
            <div className="p-8 space-y-8">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <h3 className="text-xl font-bold text-slate-900">Shopify Integration</h3>
                  <p className="text-sm text-slate-500">Connect your store via OAuth to synchronize inventory and products.</p>
                </div>
                {config?.isConnected ? (
                   <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 border border-emerald-100 rounded-full text-emerald-600 text-xs font-bold">
                    <CheckCircle2 size={14} />
                    CONNECTED
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-100 rounded-full text-slate-400 text-xs font-bold">
                    <AlertCircle size={14} />
                    NOT CONNECTED
                  </div>
                )}
              </div>

              <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-8">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Shop Domain</label>
                    <input 
                      name="shopDomain"
                      required
                      type="text" 
                      placeholder="your-store.myshopify.com" 
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary outline-none transition-all text-sm font-medium"
                      defaultValue={config?.shopDomain || ''}
                    />
                    <p className="text-[10px] text-slate-400 italic">Example: store-name.myshopify.com</p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Client ID / API Key</label>
                    <input 
                      name="clientId"
                      required
                      type="text" 
                      placeholder="Enter Client ID" 
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary outline-none transition-all text-sm font-medium"
                      defaultValue={config?.clientId || ''}
                    />
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Client Secret / API Secret</label>
                    <input 
                      name="clientSecret"
                      required={!config?.hasClientSecret}
                      type="password" 
                      placeholder={config?.hasClientSecret ? "Saved secret - leave blank to keep it" : "Enter Client Secret"}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary outline-none transition-all text-sm font-mono"
                    />
                    <p className="text-[10px] text-slate-400 italic">Credentials are encrypted at rest for maximum security.</p>
                  </div>
                </div>

                {config?.callbackUrl && (
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">OAuth Redirect URL</label>
                    <div className="flex gap-2">
                      <input
                        readOnly
                        value={config.callbackUrl}
                        className="w-full px-4 py-2.5 border border-slate-200 rounded-lg bg-slate-50 text-sm font-mono text-slate-600"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(config.callbackUrl);
                          toast.success('Redirect URL copied');
                        }}
                        className="px-4 py-2.5 border border-slate-200 rounded-lg hover:bg-slate-50 transition-all"
                        title="Copy redirect URL"
                      >
                        <Copy size={16} />
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Required Scopes</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {SCOPES.map(scope => (
                      <button
                        type="button"
                        key={scope}
                        onClick={() => {
                          if (selectedScopes.includes(scope)) {
                            setSelectedScopes(prev => prev.filter(s => s !== scope));
                          } else {
                            setSelectedScopes(prev => [...prev, scope]);
                          }
                        }}
                        className={cn(
                          "px-3 py-2 border rounded-lg text-xs font-bold transition-all text-left flex items-center gap-2",
                          selectedScopes.includes(scope)
                            ? "bg-primary/5 border-primary text-primary"
                            : "bg-white border-slate-200 text-slate-400 hover:border-slate-300"
                        )}
                      >
                        <div className={cn(
                          "w-3 h-3 rounded-sm border flex items-center justify-center",
                          selectedScopes.includes(scope) ? "bg-primary border-primary" : "border-slate-300"
                        )}>
                          {selectedScopes.includes(scope) && <CheckCircle2 size={8} className="text-white" />}
                        </div>
                        {scope}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-6 border-t border-slate-50 flex flex-wrap gap-4">
                  <button 
                    type="submit"
                    disabled={saveMutation.isPending}
                    className="bg-primary text-white px-8 py-3 rounded-xl text-xs font-black uppercase tracking-widest hover:opacity-90 transition-all shadow-lg shadow-indigo-100 flex items-center gap-2"
                  >
                    {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    Save Configuration
                  </button>

                  <button 
                    type="button"
                    disabled={testMutation.isPending}
                    onClick={() => {
                      const domain = (document.querySelector('input[name="shopDomain"]') as HTMLInputElement)?.value;
                      if (!domain) return toast.error('Enter shop domain first');
                      testMutation.mutate(domain);
                    }}
                    className="px-6 py-3 text-xs font-black text-slate-500 uppercase tracking-widest border border-slate-200 rounded-xl hover:bg-slate-50 transition-all flex items-center gap-2"
                  >
                    {testMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    Test Reachability
                  </button>

                  {config && (
                    <>
                      <button 
                        type="button"
                        onClick={() => connectMutation.mutate()}
                        disabled={connectMutation.isPending || config.isConnected || !canConnect}
                        className={cn(
                          "px-8 py-3 rounded-xl text-xs font-black uppercase tracking-widest border transition-all flex items-center gap-2",
                          config.isConnected || !canConnect
                            ? "bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed" 
                            : "bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-50"
                        )}
                      >
                        {connectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link size={14} />}
                        {config.isConnected ? 'Connected to Shopify' : 'Connect Store'}
                      </button>

                      {config.isConnected && (
                        <button 
                          type="button"
                          onClick={() => {
                            if (confirm('Disconnect from Shopify? This will stop all synchronization.')) {
                              disconnectMutation.mutate();
                            }
                          }}
                          className="px-6 py-3 text-xs font-black text-rose-500 uppercase tracking-widest border border-rose-100 rounded-xl hover:bg-rose-50 transition-all"
                        >
                          Disconnect
                        </button>
                      )}
                    </>
                  )}
                </div>
              </form>

              {config?.isConnected && (
                <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-xl flex gap-4 items-start">
                  <Zap size={20} className="text-emerald-500 mt-1 shrink-0" />
                  <div className="text-xs leading-relaxed text-emerald-900">
                    <p className="font-bold">Sync Engine Status: Active</p>
                    <p className="opacity-80">Last connected: {new Date(config.connectedAt).toLocaleString()}</p>
                    <p className="opacity-80">System using Admin GraphQL v{config.apiVersion || '2026-04'}. Throttle safety: ON</p>
                  </div>
                </div>
              )}
            </div>
          )}
          
          {activeTab !== 'shopify' && (
             <div className="p-20 text-center space-y-4">
               <div className="w-16 h-16 bg-slate-50 text-slate-200 rounded-full flex items-center justify-center mx-auto">
                 <SettingsIcon size={32} />
               </div>
               <p className="text-slate-400 font-bold uppercase tracking-widest text-[10px]">Under Development</p>
             </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsTab({ active, onClick, label, icon: Icon }: any) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-bold group",
        active 
          ? "bg-white border border-card-border shadow-sm text-primary" 
          : "text-slate-400 hover:text-slate-900 border border-transparent"
      )}
    >
      <Icon size={16} />
      {label}
    </button>
  );
}
