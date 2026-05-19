export default function ExtractionLogs({ logs }: { logs?: string[] }) {
  return (
    <div className="rounded-lg border border-card-border bg-slate-950 p-4 font-mono text-xs text-slate-100">
      {(logs?.length ? logs : ["No logs recorded yet."]).map((log, index) => <div key={index}>{log}</div>)}
    </div>
  );
}
