import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, ShieldCheck } from "lucide-react";
import { sourcesApi } from "../api/sourcesApi";

export default function SourcesPage() {
  const queryClient = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["sources"], queryFn: sourcesApi.list });
  const test = useMutation({ mutationFn: sourcesApi.test, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sources"] }) });
  const update = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => sourcesApi.update(id, { status }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sources"] }) });
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Sources</h1>
      <div className="overflow-hidden rounded-lg border border-card-border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="p-3">Source</th><th className="p-3">Type</th><th className="p-3">Mode</th><th className="p-3">Status</th><th className="p-3"></th></tr></thead>
          <tbody>
            {data.map((source) => (
              <tr key={source.id} className="border-t border-card-border">
                <td className="p-3"><div className="font-semibold">{source.name}</div><div className="text-xs text-slate-500">{source.baseUrl}</div></td>
                <td className="p-3">{source.type}</td><td className="p-3">{source.mode}</td><td className="p-3">{source.status}</td>
                <td className="p-3">
                  <div className="flex gap-2">
                    <button onClick={() => test.mutate(source.id)} className="rounded-md p-2 hover:bg-slate-100" title="Test"><ShieldCheck className="h-4 w-4" /></button>
                    <button onClick={() => update.mutate({ id: source.id, status: "PAUSED" })} className="rounded-md p-2 hover:bg-slate-100" title="Pause"><Pause className="h-4 w-4" /></button>
                    <button onClick={() => update.mutate({ id: source.id, status: "READY" })} className="rounded-md p-2 hover:bg-slate-100" title="Resume"><Play className="h-4 w-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
