import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import * as XLSX from 'xlsx';
import { Upload, FileSpreadsheet, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { apiErrorMessage } from '../lib/api';
import { cn } from '../lib/utils';

type ParsedRow = {
  rowNumber: number;
  data: Record<string, unknown>;
};

function detectUrlColumn(columns: string[]) {
  const patterns = [
    /(^|[^a-z])(url|link)($|[^a-z])/i,
    /product[\s_-]*(url|link)/i,
    /supplier[\s_-]*(url|link)/i,
  ];

  return columns.find((column) => patterns.some((pattern) => pattern.test(column))) || '';
}

function safeTrim(value: unknown) {
  return String(value ?? '').trim();
}

function runStatusBadgeClass(status: string) {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'COMPLETED') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  if (normalized === 'PARTIAL') return 'bg-amber-100 text-amber-800 border-amber-200';
  if (normalized === 'FAILED') return 'bg-rose-100 text-rose-800 border-rose-200';
  if (normalized === 'NO_CHANGES') return 'bg-slate-100 text-slate-700 border-slate-200';
  return 'bg-indigo-100 text-indigo-800 border-indigo-200';
}

export default function ExcelSheetPage() {
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [urlColumn, setUrlColumn] = useState('');
  const [selectedPricingRuleId, setSelectedPricingRuleId] = useState<string>('');
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [sheetUrl, setSheetUrl] = useState('');
  const [autoIntervalSeconds, setAutoIntervalSeconds] = useState('1800');
  const [selectedRunId, setSelectedRunId] = useState('');

  const { data: pricingRules = [] } = useQuery({
    queryKey: ['pricing-rules'],
    queryFn: async () => (await axios.get('/api/pricing-rules')).data,
    refetchOnWindowFocus: false,
  });

  const { data: collections = [] } = useQuery({
    queryKey: ['shopify-collections'],
    queryFn: async () => (await axios.get('/api/shopify/collections')).data,
    refetchOnWindowFocus: false,
  });

  const {
    data: autoSyncStatus,
    refetch: refetchAutoSyncStatus,
  } = useQuery({
    queryKey: ['excel-auto-sync-status'],
    queryFn: async () => (await axios.get('/api/imports/excel/auto-sync/status')).data,
    refetchInterval: 10000,
    refetchOnWindowFocus: false,
  });

  const {
    data: excelRuns = [],
    refetch: refetchExcelRuns,
  } = useQuery({
    queryKey: ['excel-runs'],
    queryFn: async () => (await axios.get('/api/imports/excel/runs?take=40')).data,
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
  });

  const { data: selectedRunDetails } = useQuery({
    queryKey: ['excel-run-details', selectedRunId],
    queryFn: async () => (await axios.get(`/api/imports/excel/runs/${selectedRunId}`)).data,
    enabled: Boolean(selectedRunId),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!selectedRunId && excelRuns.length > 0) {
      setSelectedRunId(excelRuns[0].id);
      return;
    }

    if (selectedRunId && excelRuns.length > 0 && !excelRuns.some((run: any) => run.id === selectedRunId)) {
      setSelectedRunId(excelRuns[0].id);
    }
  }, [excelRuns, selectedRunId]);

  useEffect(() => {
    if (!sheetUrl && autoSyncStatus?.sheetUrl) {
      setSheetUrl(String(autoSyncStatus.sheetUrl));
    }
  }, [autoSyncStatus?.sheetUrl, sheetUrl]);

  const importCandidates = useMemo(() => {
    if (!urlColumn) return [];
    return rows.map((row) => ({
      rowNumber: row.rowNumber,
      url: safeTrim(row.data[urlColumn]),
    }));
  }, [rows, urlColumn]);

  const validUrlsCount = importCandidates.filter((entry) => entry.url.length > 0).length;

  const parseFile = async (file: File) => {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new Error('The uploaded file does not contain any sheet.');
    }

    const sheet = workbook.Sheets[firstSheetName];
    const parsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (parsed.length === 0) {
      throw new Error('The uploaded sheet is empty.');
    }

    const detectedColumns = [...new Set(parsed.flatMap((row) => Object.keys(row)).map((column) => safeTrim(column)).filter(Boolean))];
    if (detectedColumns.length === 0) {
      throw new Error('No header columns found. Make sure the first row contains column names.');
    }

    const parsedRows: ParsedRow[] = parsed.map((row, index) => ({
      rowNumber: index + 2,
      data: row,
    }));

    const detectedUrlColumn = detectUrlColumn(detectedColumns);
    setFileName(file.name);
    setRows(parsedRows);
    setColumns(detectedColumns);
    setUrlColumn(detectedUrlColumn || detectedColumns[0]);
    setResult(null);
  };

  const onUploadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await parseFile(file);
      toast.success('Sheet parsed successfully.');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Failed to parse Excel sheet'));
    } finally {
      event.target.value = '';
    }
  };

  const onStartImport = async () => {
    if (!urlColumn) {
      toast.error('Select the URL column first.');
      return;
    }
    if (validUrlsCount === 0) {
      toast.error('No product URLs found in the selected column.');
      return;
    }

    setIsProcessing(true);
    setResult(null);
    try {
      const payload = {
        rows: importCandidates,
        pricingRuleId: selectedPricingRuleId || null,
        collections: selectedCollections,
        createManualReview: true,
      };
      const response = await axios.post('/api/imports/excel/process', payload, { timeout: 0 });
      setResult(response.data);
      if (response.data?.batchId) setSelectedRunId(response.data.batchId);
      refetchExcelRuns();
      toast.success('Excel import finished.');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Excel import failed'));
    } finally {
      setIsProcessing(false);
    }
  };

  const onRunSheetLinkNow = async () => {
    if (!sheetUrl.trim()) {
      toast.error('Paste Google Sheet link first.');
      return;
    }

    setIsProcessing(true);
    setResult(null);
    try {
      const response = await axios.post('/api/imports/excel/process-sheet-link', {
        sheetUrl: sheetUrl.trim(),
        pricingRuleId: selectedPricingRuleId || null,
        collections: selectedCollections,
        createManualReview: true,
        processOnlyNewRows: false,
      }, { timeout: 0 });
      setResult(response.data);
      if (response.data?.batchId) setSelectedRunId(response.data.batchId);
      toast.success('Google Sheet processed successfully.');
      refetchAutoSyncStatus();
      refetchExcelRuns();
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Failed to process Google Sheet'));
    } finally {
      setIsProcessing(false);
    }
  };

  const onStartAutoSync = async () => {
    if (!sheetUrl.trim()) {
      toast.error('Paste Google Sheet link first.');
      return;
    }
    const seconds = Number(autoIntervalSeconds);
    if (!Number.isFinite(seconds) || seconds < 20) {
      toast.error('Auto sync interval must be at least 20 seconds.');
      return;
    }

    try {
      await axios.post('/api/imports/excel/auto-sync/start', {
        sheetUrl: sheetUrl.trim(),
        intervalSeconds: Math.floor(seconds),
        pricingRuleId: selectedPricingRuleId || null,
        collections: selectedCollections,
        createManualReview: true,
      });
      toast.success('Auto sync started.');
      refetchAutoSyncStatus();
      refetchExcelRuns();
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Failed to start auto sync'));
    }
  };

  const onStopAutoSync = async () => {
    try {
      await axios.post('/api/imports/excel/auto-sync/stop');
      toast.success('Auto sync stopped.');
      refetchAutoSyncStatus();
      refetchExcelRuns();
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Failed to stop auto sync'));
    }
  };

  const toggleCollection = (collectionId: string) => {
    setSelectedCollections((prev) =>
      prev.includes(collectionId)
        ? prev.filter((id) => id !== collectionId)
        : [...prev, collectionId],
    );
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">Excel Sheet Import</h1>
        <p className="text-slate-500 font-medium">
          Upload one Excel file, process products in bulk, auto-publish good rows, and send failed rows to Manual Review.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-card-border shadow-sm p-6 space-y-5">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <div className="text-sm font-bold text-slate-800">Google Sheet Link (Auto Mode)</div>
          <input
            type="text"
            value={sheetUrl}
            onChange={(event) => setSheetUrl(event.target.value)}
            placeholder="Paste Google Sheet link (columns: link / price / collection)"
            className="w-full rounded-lg border border-slate-200 bg-white py-2.5 px-3 text-sm font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-primary/20"
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input
              type="number"
              min={20}
              value={autoIntervalSeconds}
              onChange={(event) => setAutoIntervalSeconds(event.target.value)}
              className="rounded-lg border border-slate-200 bg-white py-2.5 px-3 text-sm font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-primary/20"
              placeholder="Interval seconds"
            />
            <button
              type="button"
              onClick={onRunSheetLinkNow}
              disabled={isProcessing}
              className="rounded-lg bg-primary text-white px-4 py-2.5 text-xs font-black uppercase tracking-widest hover:opacity-90 disabled:opacity-60"
            >
              Run From Link Now
            </button>
            {autoSyncStatus?.running ? (
              <button
                type="button"
                onClick={onStopAutoSync}
                className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-4 py-2.5 text-xs font-black uppercase tracking-widest hover:bg-rose-100"
              >
                Stop Auto Sync
              </button>
            ) : (
              <button
                type="button"
                onClick={onStartAutoSync}
                className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 px-4 py-2.5 text-xs font-black uppercase tracking-widest hover:bg-emerald-100"
              >
                Start Auto Sync
              </button>
            )}
          </div>
          <div className="text-xs font-semibold text-slate-500">
            Status: <span className={cn(autoSyncStatus?.running ? 'text-emerald-600' : 'text-slate-500')}>
              {autoSyncStatus?.running ? 'Running' : 'Stopped'}
            </span>
            {autoSyncStatus?.lastRunAt ? ` / Last run: ${new Date(autoSyncStatus.lastRunAt).toLocaleString()}` : ''}
            {autoSyncStatus?.lastError ? ` / Last error: ${autoSyncStatus.lastError}` : ''}
          </div>
        </div>

        <label className="flex flex-col items-center justify-center gap-3 border-2 border-dashed border-slate-200 rounded-xl p-8 cursor-pointer hover:border-primary/40 transition-colors">
          <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center">
            <Upload className="h-5 w-5 text-slate-500" />
          </div>
          <div className="text-center">
            <div className="font-bold text-slate-800">Upload `.xlsx`, `.xls`, or `.csv`</div>
            <div className="text-xs font-semibold text-slate-500">The first sheet will be used automatically.</div>
          </div>
          <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onUploadFile} />
        </label>

        {rows.length > 0 && (
          <div className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-700">
                <FileSpreadsheet className="h-4 w-4 text-slate-500" />
                {fileName}
              </div>
              <div className="text-xs font-semibold text-slate-500">
                {rows.length} rows parsed / {validUrlsCount} URL rows ready
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">URL Column</label>
                <select
                  value={urlColumn}
                  onChange={(event) => setUrlColumn(event.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white py-2.5 px-3 text-sm font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-primary/20"
                >
                  {columns.map((column) => (
                    <option key={column} value={column}>{column}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Pricing Rule (optional)</label>
                <select
                  value={selectedPricingRuleId}
                  onChange={(event) => setSelectedPricingRuleId(event.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white py-2.5 px-3 text-sm font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">Auto Select Best Rule</option>
                  {pricingRules.map((rule: any) => (
                    <option key={rule.id} value={rule.id}>
                      {rule.name} {rule.isDefault ? '(Default)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Collections (optional)</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                {collections.length === 0 && (
                  <div className="rounded-lg border border-slate-200 p-3 text-xs font-semibold text-slate-500 bg-slate-50">
                    No Shopify collections found.
                  </div>
                )}
                {collections.map((collection: any) => {
                  const selected = selectedCollections.includes(collection.id);
                  return (
                    <button
                      key={collection.id}
                      type="button"
                      onClick={() => toggleCollection(collection.id)}
                      className={cn(
                        'rounded-lg border px-3 py-2 text-left text-xs font-bold transition-all',
                        selected
                          ? 'border-primary bg-primary/5 text-primary'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
                      )}
                    >
                      {collection.title}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              onClick={onStartImport}
              disabled={isProcessing}
              className="bg-primary text-white px-5 py-2.5 rounded-md text-xs font-bold uppercase tracking-widest hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {isProcessing ? 'Processing...' : 'Start Bulk Import'}
            </button>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="bg-white rounded-xl border border-card-border shadow-sm p-6">
          <div className="text-sm font-bold text-slate-800 mb-3">Preview (first 8 rows)</div>
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">Row</th>
                  <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">{urlColumn || 'URL'}</th>
                </tr>
              </thead>
              <tbody>
                {importCandidates.slice(0, 8).map((entry) => (
                  <tr key={entry.rowNumber} className="border-b border-slate-50">
                    <td className="px-3 py-2 font-mono text-slate-500">{entry.rowNumber}</td>
                    <td className="px-3 py-2 font-semibold text-slate-700 break-all">{entry.url || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-card-border shadow-sm p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Sheet Runs Timeline</h2>
            <p className="text-xs font-semibold text-slate-500">
              Professional tracking for each sheet execution with exact date/time and per-row status.
            </p>
          </div>
          <button
            type="button"
            onClick={() => refetchExcelRuns()}
            className="rounded-md border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-600 hover:bg-slate-50"
          >
            Refresh
          </button>
        </div>

        <div className="overflow-auto rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">Run Time</th>
                <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">Mode</th>
                <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">Status</th>
                <th className="px-3 py-2 text-right font-black text-slate-400 uppercase tracking-widest">Published</th>
                <th className="px-3 py-2 text-right font-black text-slate-400 uppercase tracking-widest">Synced</th>
                <th className="px-3 py-2 text-right font-black text-slate-400 uppercase tracking-widest">Skipped</th>
                <th className="px-3 py-2 text-right font-black text-slate-400 uppercase tracking-widest">Failed</th>
                <th className="px-3 py-2 text-right font-black text-slate-400 uppercase tracking-widest">Processed</th>
              </tr>
            </thead>
            <tbody>
              {excelRuns.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-slate-400 font-semibold">
                    No sheet runs recorded yet.
                  </td>
                </tr>
              ) : excelRuns.map((run: any) => {
                const active = selectedRunId === run.id;
                const summary = run.summary || {};
                return (
                  <tr
                    key={run.id}
                    onClick={() => setSelectedRunId(run.id)}
                    className={cn(
                      'border-b border-slate-100 cursor-pointer hover:bg-slate-50',
                      active && 'bg-indigo-50/40',
                    )}
                  >
                    <td className="px-3 py-2 font-semibold text-slate-700">
                      {new Date(run.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-slate-600 font-bold uppercase">{String(run.mode || 'unknown').replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2">
                      <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider', runStatusBadgeClass(run.status))}>
                        {run.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-emerald-700">{summary.published || 0}</td>
                    <td className="px-3 py-2 text-right font-bold text-indigo-700">{summary.syncedExisting || 0}</td>
                    <td className="px-3 py-2 text-right font-bold text-slate-600">{summary.skipped || 0}</td>
                    <td className="px-3 py-2 text-right font-bold text-rose-700">{summary.failed || 0}</td>
                    <td className="px-3 py-2 text-right font-bold text-slate-700">{summary.processedRows || summary.total || summary.totalRowsInSheet || 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {selectedRunDetails && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-lg border border-slate-200 p-4 space-y-2 bg-slate-50/50">
              <div className="text-sm font-bold text-slate-800">Run Details</div>
              <div className="text-xs text-slate-600"><span className="font-black text-slate-700">Run ID:</span> {selectedRunDetails.id}</div>
              <div className="text-xs text-slate-600"><span className="font-black text-slate-700">Started:</span> {new Date(selectedRunDetails.createdAt).toLocaleString()}</div>
              <div className="text-xs text-slate-600"><span className="font-black text-slate-700">Status:</span> {selectedRunDetails.status}</div>
              <div className="text-xs text-slate-600 break-all">
                <span className="font-black text-slate-700">Sheet:</span> {selectedRunDetails.sheetUrl || '-'}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 p-4 space-y-2 bg-slate-50/50">
              <div className="text-sm font-bold text-slate-800">Outcome</div>
              <div className="text-xs text-slate-600"><span className="font-black text-slate-700">Published:</span> {selectedRunDetails.summary?.published || 0}</div>
              <div className="text-xs text-slate-600"><span className="font-black text-slate-700">Synced Existing:</span> {selectedRunDetails.summary?.syncedExisting || 0}</div>
              <div className="text-xs text-slate-600"><span className="font-black text-slate-700">Skipped:</span> {selectedRunDetails.summary?.skipped || 0}</div>
              <div className="text-xs text-slate-600"><span className="font-black text-slate-700">Failed:</span> {selectedRunDetails.summary?.failed || 0}</div>
              <div className="text-xs text-slate-600"><span className="font-black text-slate-700">Manual Review:</span> {selectedRunDetails.summary?.manualReviewCreated || 0}</div>
              <div className="text-xs text-slate-600"><span className="font-black text-slate-700">Processed Rows:</span> {selectedRunDetails.summary?.processedRows || selectedRunDetails.summary?.total || selectedRunDetails.summary?.totalRowsInSheet || 0}</div>
            </div>
          </div>
        )}

        {selectedRunDetails && Array.isArray(selectedRunDetails.failed) && selectedRunDetails.failed.length > 0 && (
          <div>
            <div className="text-sm font-bold text-slate-800 mb-2">Failed Rows In Selected Run</div>
            <div className="overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">Row</th>
                    <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">URL</th>
                    <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRunDetails.failed.slice(0, 80).map((entry: any) => (
                    <tr key={`${selectedRunDetails.id}-${entry.rowNumber}-${entry.url}`} className="border-b border-slate-100">
                      <td className="px-3 py-2 font-mono text-slate-500">{entry.rowNumber}</td>
                      <td className="px-3 py-2 font-semibold text-slate-700 break-all">{entry.url || '-'}</td>
                      <td className="px-3 py-2 text-amber-800 font-semibold">{entry.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {selectedRunDetails && Array.isArray(selectedRunDetails.skipped) && selectedRunDetails.skipped.length > 0 && (
          <div>
            <div className="text-sm font-bold text-slate-800 mb-2">Skipped Rows In Selected Run</div>
            <div className="overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">Row</th>
                    <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">URL</th>
                    <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRunDetails.skipped.slice(0, 80).map((entry: any) => (
                    <tr key={`${selectedRunDetails.id}-${entry.rowNumber}-${entry.url}-skipped`} className="border-b border-slate-100">
                      <td className="px-3 py-2 font-mono text-slate-500">{entry.rowNumber}</td>
                      <td className="px-3 py-2 font-semibold text-slate-700 break-all">{entry.url || '-'}</td>
                      <td className="px-3 py-2 text-slate-700 font-semibold">{entry.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="bg-white rounded-xl border border-card-border shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-slate-900">Import Result</h2>
            <Link to="/review" className="text-xs font-black uppercase tracking-widest text-primary hover:underline">
              Open Manual Review
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
            <div className="rounded-lg border border-slate-200 p-3 bg-slate-50">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Total</div>
              <div className="text-xl font-bold text-slate-800">{result.summary?.total || result.summary?.totalRowsInSheet || 0}</div>
            </div>
            <div className="rounded-lg border border-emerald-200 p-3 bg-emerald-50">
              <div className="text-[10px] font-black uppercase tracking-widest text-emerald-600">Published</div>
              <div className="text-xl font-bold text-emerald-700">{result.summary?.published || 0}</div>
            </div>
            <div className="rounded-lg border border-indigo-200 p-3 bg-indigo-50">
              <div className="text-[10px] font-black uppercase tracking-widest text-indigo-600">Synced</div>
              <div className="text-xl font-bold text-indigo-700">{result.summary?.syncedExisting || 0}</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-3 bg-slate-50">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-600">Skipped</div>
              <div className="text-xl font-bold text-slate-700">{result.summary?.skipped || 0}</div>
            </div>
            <div className="rounded-lg border border-amber-200 p-3 bg-amber-50">
              <div className="text-[10px] font-black uppercase tracking-widest text-amber-700">Issues</div>
              <div className="text-xl font-bold text-amber-800">{result.summary?.failed || 0}</div>
            </div>
            <div className="rounded-lg border border-indigo-200 p-3 bg-indigo-50">
              <div className="text-[10px] font-black uppercase tracking-widest text-indigo-700">Manual Review Created</div>
              <div className="text-xl font-bold text-indigo-800">{result.summary?.manualReviewCreated || 0}</div>
            </div>
          </div>

          {Array.isArray(result.failed) && result.failed.length > 0 && (
            <div>
              <div className="text-sm font-bold text-slate-800 mb-2">Failed Rows</div>
              <div className="overflow-auto rounded-lg border border-slate-200">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">Row</th>
                      <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">URL</th>
                      <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">Issue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.failed.slice(0, 100).map((entry: any) => (
                      <tr key={`${entry.rowNumber}-${entry.url}`} className="border-b border-slate-100">
                        <td className="px-3 py-2 font-mono text-slate-500">{entry.rowNumber}</td>
                        <td className="px-3 py-2 font-semibold text-slate-700 break-all">{entry.url || '-'}</td>
                        <td className="px-3 py-2 text-amber-800 font-semibold">
                          <span className="inline-flex items-center gap-1">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            {entry.reason}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {Array.isArray(result.skipped) && result.skipped.length > 0 && (
            <div>
              <div className="text-sm font-bold text-slate-800 mb-2">Skipped Rows</div>
              <div className="overflow-auto rounded-lg border border-slate-200">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">Row</th>
                      <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">URL</th>
                      <th className="px-3 py-2 text-left font-black text-slate-400 uppercase tracking-widest">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.skipped.slice(0, 100).map((entry: any) => (
                      <tr key={`${entry.rowNumber}-${entry.url}-skipped`} className="border-b border-slate-100">
                        <td className="px-3 py-2 font-mono text-slate-500">{entry.rowNumber}</td>
                        <td className="px-3 py-2 font-semibold text-slate-700 break-all">{entry.url || '-'}</td>
                        <td className="px-3 py-2 text-slate-700 font-semibold">{entry.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
