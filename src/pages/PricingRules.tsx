import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Plus, 
  Trash2, 
  Check, 
  Percent, 
  DollarSign, 
  TrendingUp,
  AlertCircle,
  X,
  ChevronDown
} from 'lucide-react';
import axios from 'axios';
import { toast } from 'sonner';
import { cn } from '../lib/utils';
import { apiErrorMessage } from '../lib/api';
import { motion, AnimatePresence } from 'motion/react';

export default function PricingRules() {
  const queryClient = useQueryClient();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<any>(null);
  
  const { data: rules, isLoading } = useQuery({
    queryKey: ['pricing-rules'],
    queryFn: async () => {
      const { data } = await axios.get('/api/pricing-rules');
      return data;
    }
  });

  const { data: suppliers } = useQuery({
    queryKey: ['suppliers'],
    queryFn: async () => {
      const { data } = await axios.get('/api/suppliers');
      return data;
    }
  });

  const createMutation = useMutation({
    mutationFn: async (newRule: any) => axios.post('/api/pricing-rules', newRule),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pricing-rules'] });
      toast.success('New pricing rule created');
      setIsModalOpen(false);
      setEditingRule(null);
    },
    onError: (error: any) => {
      toast.error(apiErrorMessage(error, 'Failed to create rule'));
    }
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: any) => axios.patch(`/api/pricing-rules/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pricing-rules'] });
      toast.success('Pricing rule updated');
      setIsModalOpen(false);
      setEditingRule(null);
    },
    onError: (error: any) => {
      toast.error(apiErrorMessage(error, 'Failed to update rule'));
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => axios.delete(`/api/pricing-rules/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pricing-rules'] });
      toast.success('Rule deleted');
    }
  });

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const data = {
      name: formData.get('name'),
      supplierId: formData.get('supplierId') || null,
      currency: formData.get('currency') || null,
      multiplier: parseFloat(formData.get('multiplier') as string) || 1.0,
      fixedMarkup: parseFloat(formData.get('fixedMarkup') as string) || 0.0,
      percentageMarkup: parseFloat(formData.get('percentageMarkup') as string) || 0.0,
      rounding: formData.get('rounding'),
      minPrice: formData.get('minPrice') ? parseFloat(formData.get('minPrice') as string) : null,
      maxPrice: formData.get('maxPrice') ? parseFloat(formData.get('maxPrice') as string) : null,
      isDefault: formData.get('isDefault') === 'on'
    };
    if (editingRule) {
      updateMutation.mutate({ id: editingRule.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const openCreateModal = () => {
    setEditingRule(null);
    setIsModalOpen(true);
  };

  const openEditModal = (rule: any) => {
    setEditingRule(rule);
    setIsModalOpen(true);
  };

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Pricing Rules</h1>
          <p className="text-slate-500 font-medium">Define how supplier prices are converted to your Shopify store.</p>
        </div>
        <button 
          onClick={openCreateModal}
          className="bg-primary text-white px-5 py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 shadow-lg shadow-indigo-100 hover:opacity-90 transition-all"
        >
          <Plus className="h-4 w-4" />
          CREATE NEW RULE
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {rules?.map((rule: any) => (
          <div key={rule.id} className="bg-white rounded-xl border border-card-border shadow-sm p-6 space-y-4 relative group hover:border-primary transition-all">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <h3 className="font-bold text-slate-900">{rule.name}</h3>
                <div className="flex flex-wrap gap-2">
                  {rule.isDefault && (
                    <span className="bg-indigo-50 text-primary text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider border border-indigo-100">
                      Active Default
                    </span>
                  )}
                  {rule.supplierId && (
                    <span className="bg-slate-100 text-slate-600 text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider border border-slate-200">
                      {suppliers?.find((s: any) => s.id === rule.supplierId)?.name || 'Custom'}
                    </span>
                  )}
                </div>
              </div>
              <button 
                onClick={() => deleteMutation.mutate(rule.id)}
                className="p-1.5 text-slate-400 hover:text-rose-500 transition-colors"
                title="Delete Rule"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Multiplier</label>
                <div className="text-lg font-bold text-slate-700">x{rule.multiplier}</div>
              </div>
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Fixed Markup</label>
                <div className="text-lg font-bold text-slate-700">${rule.fixedMarkup}</div>
              </div>
            </div>

            <div className="space-y-2 pt-2">
              <div className="flex justify-between text-xs font-medium">
                <span className="text-slate-500">Currency</span>
                <span className="text-slate-900">{rule.currency || 'Any'}</span>
              </div>
              <div className="flex justify-between text-xs font-medium">
                <span className="text-slate-500">Rounding</span>
                <span className="text-slate-900">{rule.rounding || 'None'}</span>
              </div>
              <div className="flex justify-between text-xs font-medium">
                <span className="text-slate-500">Min Price</span>
                <span className="text-slate-900">{rule.minPrice ? `$${rule.minPrice}` : 'None'}</span>
              </div>
              {rule.percentageMarkup > 0 && (
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-slate-500">Percent Markup</span>
                  <span className="text-slate-900">{rule.percentageMarkup}%</span>
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-slate-50 flex gap-2">
              <button
                type="button"
                onClick={() => openEditModal(rule)}
                className="flex-1 text-[10px] font-black text-slate-500 uppercase tracking-widest py-2 border border-slate-100 rounded hover:bg-slate-50 transition-all"
              >
                Edit Configuration
              </button>
            </div>
          </div>
        ))}

        <button 
          onClick={openCreateModal}
          className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-xl p-6 flex flex-col items-center justify-center gap-3 text-center opacity-60 hover:opacity-100 transition-all cursor-pointer group"
        >
          <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center text-slate-500 group-hover:bg-primary group-hover:text-white transition-colors">
            <Plus />
          </div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-widest group-hover:text-slate-900">Add Custom Override</p>
        </button>
      </div>

      <AnimatePresence>
        {isModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsModalOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-2xl shadow-2xl border border-card-border w-full max-w-xl relative z-10 overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-card-border flex justify-between items-center bg-slate-50/50">
                <h2 className="font-bold text-lg text-slate-900">{editingRule ? 'Edit Pricing Rule' : 'New Pricing Rule'}</h2>
                <button 
                  onClick={() => {
                    setIsModalOpen(false);
                    setEditingRule(null);
                  }}
                  className="p-1 text-slate-400 hover:text-slate-900 transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form key={editingRule?.id || 'new'} onSubmit={handleSubmit} className="p-6 space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  <div className="col-span-2 space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Rule Name</label>
                    <input 
                      name="name" 
                      required 
                      placeholder="e.g. Zara Standard Markup"
                      defaultValue={editingRule?.name || ''}
                      className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary outline-none transition-all text-sm font-medium"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Supplier (Optional)</label>
                    <div className="relative">
                      <select 
                        name="supplierId"
                        defaultValue={editingRule?.supplierId || ''}
                        className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary outline-none transition-all text-sm font-medium appearance-none"
                      >
                        <option value="">Apply to All</option>
                        {suppliers?.map((s: any) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Currency (Optional)</label>
                    <input
                      name="currency"
                      placeholder="Any"
                      defaultValue={editingRule?.currency || ''}
                      className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary outline-none transition-all text-sm font-medium uppercase"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Rounding</label>
                    <div className="relative">
                      <select 
                        name="rounding"
                        className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary outline-none transition-all text-sm font-medium appearance-none"
                        defaultValue={editingRule?.rounding || 'none'}
                      >
                        <option value="none">None</option>
                        <option value=".99">Round to .99</option>
                        <option value=".00">Round to .00</option>
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Multiplier</label>
                    <div className="relative">
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-xs">x</div>
                      <input 
                        name="multiplier" 
                        type="number" 
                        step="0.01" 
                        defaultValue={editingRule?.multiplier ?? '1.50'}
                        className="w-full pl-7 pr-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary outline-none transition-all text-sm font-medium"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Fixed Markup ($)</label>
                    <div className="relative">
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-xs">$</div>
                      <input 
                        name="fixedMarkup" 
                        type="number" 
                        step="0.01" 
                        defaultValue={editingRule?.fixedMarkup ?? '0.00'}
                        className="w-full pl-7 pr-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary outline-none transition-all text-sm font-medium"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Percent Markup</label>
                    <div className="relative">
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-xs">%</div>
                      <input
                        name="percentageMarkup"
                        type="number"
                        step="0.01"
                        defaultValue={editingRule?.percentageMarkup ?? '0.00'}
                        className="w-full px-4 pr-7 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary outline-none transition-all text-sm font-medium"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Min Price Limit</label>
                    <input 
                      name="minPrice" 
                      type="number" 
                      step="0.01" 
                      placeholder="No Minimum"
                      defaultValue={editingRule?.minPrice ?? ''}
                      className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary outline-none transition-all text-sm font-medium"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Max Price Limit</label>
                    <input 
                      name="maxPrice" 
                      type="number" 
                      step="0.01" 
                      placeholder="No Maximum"
                      defaultValue={editingRule?.maxPrice ?? ''}
                      className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary outline-none transition-all text-sm font-medium"
                    />
                  </div>
                  
                  <div className="col-span-2 py-2 flex items-center gap-3">
                    <input type="checkbox" name="isDefault" id="isDefault" defaultChecked={Boolean(editingRule?.isDefault)} className="w-4 h-4 rounded text-primary focus:ring-primary border-slate-300" />
                    <label htmlFor="isDefault" className="text-sm font-bold text-slate-700">Set as default rule for new imports</label>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-50 flex gap-3">
                  <button 
                    type="button"
                    onClick={() => {
                      setIsModalOpen(false);
                      setEditingRule(null);
                    }}
                    className="flex-1 px-6 py-3 rounded-xl border border-slate-200 text-xs font-black text-slate-500 uppercase tracking-widest hover:bg-slate-50 transition-all font-sans"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit"
                    disabled={createMutation.isPending || updateMutation.isPending}
                    className="flex-[1.5] bg-primary text-white px-6 py-3 rounded-xl text-xs font-black uppercase tracking-widest hover:opacity-90 transition-all shadow-lg shadow-indigo-100 flex items-center justify-center gap-2"
                  >
                    {createMutation.isPending || updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : editingRule ? 'Save Rule' : 'Create Rule'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="bg-indigo-900 rounded-2xl p-8 text-white flex flex-col md:flex-row gap-8 items-center relative overflow-hidden">
        <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
          <TrendingUp size={240} />
        </div>
        <div className="flex-1 space-y-4 relative z-10">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-500 rounded flex items-center justify-center">
              <AlertCircle size={18} />
            </div>
            <h2 className="text-xl font-bold uppercase tracking-tight">Safety Buffer Enforced</h2>
          </div>
          <p className="text-indigo-200 text-sm leading-relaxed max-w-xl">
            Our pricing engine includes an automatic <strong>Manual Review</strong> trigger whenever a conversion results in a 
            price deviation higher than 20%. This prevents costly errors during supplier flash sales.
          </p>
        </div>
        <div className="shrink-0 relative z-10">
           <button className="bg-white text-indigo-900 px-6 py-3 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-indigo-50 transition-all">
            Adjust Buffers
          </button>
        </div>
      </div>
    </div>
  );
}

function Loader2({ className }: { className?: string }) {
  return (
    <svg 
      className={cn("animate-spin", className)} 
      xmlns="http://www.w3.org/2000/svg" 
      width="24" 
      height="24" 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
