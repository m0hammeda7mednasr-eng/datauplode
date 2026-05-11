import { useQuery } from '@tanstack/react-query';
import { 
  TrendingUp, 
  Package, 
  AlertCircle, 
  Clock, 
  ExternalLink, 
  CheckCircle2, 
  Image as ImageIcon,
  DollarSign,
  PlusCircle,
  RefreshCw
} from 'lucide-react';
import axios from 'axios';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';

export default function Dashboard() {
  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: async () => ({
      totalProducts: 42,
      activeSyncs: 38,
      pendingReviews: 12,
      lastSync: '24 mins ago'
    })
  });

  const { data: recentProducts } = useQuery({
    queryKey: ['recent-products'],
    queryFn: async () => [
      { id: '1', title: 'Zara Minimalist Coat', supplier: 'Zara', price: 129.99, status: 'synced', lastSync: '10m ago' },
      { id: '2', title: 'H&M Linen Shirt', supplier: 'H&M', price: 29.99, status: 'error', lastSync: '1h ago' },
      { id: '3', title: 'Shein Boho Dress', supplier: 'Shein', price: 45.50, status: 'synced', lastSync: '15m ago' },
      { id: '4', title: 'Zara Leather Boots', supplier: 'Zara', price: 89.00, status: 'synced', lastSync: '45m ago' },
    ]
  });

  return (
    <div className="space-y-10 animate-in fade-in duration-700">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Dashboard</h1>
          <p className="text-slate-500 font-medium text-sm">System snapshot and real-time inventory health.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <StatCard icon={Package} label="Total Products" value={stats?.totalProducts} color="zinc" />
        <StatCard icon={TrendingUp} label="Active Sync" value={stats?.activeSyncs} color="indigo" />
        <StatCard icon={AlertCircle} label="Manual Review" value={stats?.pendingReviews} color="amber" />
        <StatCard icon={Clock} label="System Status" value="Healthy" color="emerald" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <SectionHeader title="Recent Activity" />
          <div className="bg-white rounded-xl border border-card-border shadow-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-card-border">
                <tr>
                  <th className="px-6 py-4 text-left font-black text-slate-400 uppercase tracking-widest">Product</th>
                  <th className="px-6 py-4 text-left font-black text-slate-400 uppercase tracking-widest">Supplier</th>
                  <th className="px-6 py-4 text-left font-black text-slate-400 uppercase tracking-widest">Status</th>
                  <th className="px-6 py-4 text-right font-black text-slate-400 uppercase tracking-widest">Last Activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {recentProducts?.map((p, i) => (
                  <tr key={p.id} className="group hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-bold text-slate-900 group-hover:text-primary transition-colors">{p.title}</div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-mono text-[10px] font-bold">
                        {p.supplier}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className={cn(
                        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded font-black uppercase text-[9px] tracking-tight",
                        p.status === 'synced' ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                      )}>
                        <div className={cn("w-1 h-1 rounded-full", p.status === 'synced' ? "bg-emerald-500" : "bg-rose-500")} />
                        {p.status}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right text-slate-400 font-mono text-[10px] italic">{p.lastSync}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="p-4 bg-slate-50/50 border-t border-card-border text-center">
              <button className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline">View All Active Syncs</button>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <SectionHeader title="Quick Actions" />
          <div className="grid grid-cols-1 gap-4">
            <ActionButton 
              title="Add Shopify Store" 
              desc="Configure API credentials" 
              icon={PlusCircle} 
            />
            <ActionButton 
              title="Pricing Wizard" 
              desc="Edit global markup rules" 
              icon={DollarSign} 
            />
            <ActionButton 
              title="Sync Schedule" 
              desc="Manage automation intervals" 
              icon={RefreshCw} 
            />
            
            <div className="p-6 bg-slate-900 rounded-xl text-white relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 transition-transform group-hover:scale-110">
                <CheckCircle2 size={80} />
              </div>
              <div className="relative z-10 space-y-2">
                <div className="bg-emerald-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full inline-block uppercase tracking-wider mb-2">System Active</div>
                <h4 className="font-bold text-lg">Syncly Pro</h4>
                <p className="text-slate-400 text-xs leading-relaxed">Background synchronization is currently monitoring 1,204 variants across 3 suppliers.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: any) {
  return (
    <motion.div 
      whileHover={{ y: -4 }}
      className="bg-white p-6 rounded-xl border border-card-border shadow-sm space-y-4"
    >
      <div className={cn(
        "w-10 h-10 rounded-lg flex items-center justify-center border",
        color === 'indigo' ? "bg-indigo-50 text-indigo-600 border-indigo-100" :
        color === 'amber' ? "bg-amber-50 text-amber-600 border-amber-100" :
        color === 'emerald' ? "bg-emerald-50 text-emerald-600 border-emerald-100" : 
        "bg-slate-50 text-slate-600 border-slate-100"
      )}>
        <Icon size={18} strokeWidth={2.5} />
      </div>
      <div>
        <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mb-1">{label}</p>
        <p className="text-3xl font-black text-slate-900">{value}</p>
      </div>
    </motion.div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-4">
      <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 shrink-0">{title}</h3>
      <div className="h-[1px] flex-1 bg-slate-200" />
    </div>
  );
}

function ActionButton({ title, desc, icon: Icon }: any) {
  return (
    <button className="flex items-center gap-4 p-4 bg-white border border-card-border rounded-xl hover:border-primary transition-all group text-left shadow-sm">
      <div className="p-2.5 bg-slate-50 rounded-lg group-hover:bg-primary group-hover:text-white transition-colors border border-slate-100 group-hover:border-primary">
        <Icon size={16} />
      </div>
      <div>
        <h4 className="font-bold text-sm text-slate-900">{title}</h4>
        <p className="text-slate-500 text-[11px] font-medium leading-tight">{desc}</p>
      </div>
    </button>
  );
}
