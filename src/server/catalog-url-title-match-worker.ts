import { prisma } from './db.js';
import { ShopifyService } from './services/shopify.js';
import { loadGoogleSheetRows, type GoogleSheetRow } from './api.js';

const CACHE_TABLE = 'ShopifyCatalogIndexV2';
const JOB_TYPE = 'CATALOG_URL_TITLE_MATCH:2026-09-04-v1';
const BIG_SPREADSHEET_ID = '1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w';
const LEGACY_SPREADSHEET_ID = '13JSw5k_wX8RAd98P-TWLT-938ImshAtrukjjA4n-lkI';
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.CATALOG_URL_TITLE_MATCH_CONCURRENCY || 4)));
const LIMIT = Math.max(1, Number(process.env.CATALOG_URL_TITLE_MATCH_LIMIT || 10000));

const SHEETS = [
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة1', gid: 0 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة2', gid: 531292068 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة15', gid: 242585683 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة10', gid: 1991302797 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة6', gid: 1951926772 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة7', gid: 93159589 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة8', gid: 916372394 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة20', gid: 202697256 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة9', gid: 1264806944 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة11', gid: 106757984 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة12', gid: 1841878091 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة13', gid: 1219566712 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة16', gid: 1526682180 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة18', gid: 1122116162 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة19', gid: 16172014 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة21', gid: 1993452910 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة22', gid: 282692873 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة23', gid: 770232216 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة24', gid: 1210585516 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة25', gid: 307824540 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة26', gid: 1459453928 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة27', gid: 4356284 },
  { id: BIG_SPREADSHEET_ID, name: 'dap_data', tab: 'الورقة28', gid: 422632561 },
  { id: LEGACY_SPREADSHEET_ID, name: 'legacy_4_sheet', tab: 'الورقة1', gid: 0 },
  { id: LEGACY_SPREADSHEET_ID, name: 'legacy_4_sheet', tab: 'الورقة2', gid: 1503940200 },
  { id: LEGACY_SPREADSHEET_ID, name: 'legacy_4_sheet', tab: 'الورقة3', gid: 635942262 },
  { id: LEGACY_SPREADSHEET_ID, name: 'legacy_4_sheet', tab: 'الورقة4', gid: 1210175544 },
] as const;

type SourceRow = GoogleSheetRow & {
  canonicalUrl: string;
  vendorKey: string;
  titleKey: string;
  spreadsheetId: string;
  spreadsheetName: string;
  sheetName: string;
  gid: number;
  sheetUrl: string;
};

type CacheRow = {
  shopifyId: string;
  title: string;
  vendor: string | null;
  matchStatus: string;
};

function enabled(name: string, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function clean(value: unknown) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function compact(value: unknown) { return clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, ''); }

function vendorKey(value: unknown) {
  const k = compact(value);
  if (!k) return '';
  if (['NXT','NEXT'].includes(k)) return 'NEXT';
  if (['HM','HANDM'].includes(k)) return 'HM';
  if (['MAX','MAXFASHION'].includes(k)) return 'MAX';
  if (['CENTREPOINT','CENTREPOINTSTORES'].includes(k)) return 'CENTREPOINT';
  if (['MNS','MS','MARKSANDSPENCER','MARKSSPENCER'].includes(k)) return 'MARKSANDSPENCER';
  if (k.startsWith('CARTER')) return 'CARTERS';
  return k;
}

function vendorFromUrl(url: string) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes('next.')) return 'NEXT';
    if (h.includes('hm.com')) return 'HM';
    if (h.includes('maxfashion')) return 'MAX';
    if (h.includes('centrepoint')) return 'CENTREPOINT';
    if (h.includes('shein')) return 'SHEIN';
    if (h.includes('lefties')) return 'LEFTIES';
    if (h.includes('marksandspencer')) return 'MARKSANDSPENCER';
    if (h.includes('carters')) return 'CARTERS';
    if (h.includes('zara')) return 'ZARA';
    if (h.includes('adidas')) return 'ADIDAS';
    if (h.includes('mothercare')) return 'MOTHERCARE';
    if (h.includes('gap.')) return 'GAP';
    return '';
  } catch { return ''; }
}

function normalize(value: unknown) {
  return clean(value).replace(/&amp;/gi,' and ').replace(/&/g,' and ').replace(/[’‘`]/g,"'")
    .replace(/[^a-z0-9]+/gi,' ').replace(/\s+/g,' ').trim().toLowerCase();
}

function identityTitle(value: unknown) {
  let t = clean(value);
  t = t
    .replace(/\s*[-–—|]\s*size\s+.+$/i,'')
    .replace(/\s*\(\s*size\s*[:=-]?.+\)\s*$/i,'')
    .replace(/\s*\((?:\d+\s*(?:mths?|months?|yrs?|years?)\s*[-–]\s*\d+\s*(?:mths?|months?|yrs?|years?))\)\s*$/i,'')
    .replace(/\s*[-–—|]\s*(?:newborn|tiny baby|premature|preemie|\d+\s*(?:-|to)\s*\d+\s*(?:months?|mths?|years?|yrs?)).*$/i,'')
    .trim();
  const n = normalize(t);
  return n.split(' ').filter(Boolean).length >= 3 && n.length >= 14 ? n : '';
}

function canonicalUrl(value: unknown) {
  try {
    const u = new URL(clean(value).replace(/[),.;]+$/,''));
    u.hash='';
    u.hostname=u.hostname.toLowerCase().replace(/^m\./,'www.');
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|ref|source)/i.test(k)) u.searchParams.delete(k);
    u.pathname=u.pathname.replace(/\/+$/,'');
    return u.toString().replace(/\/$/,'').toLowerCase();
  } catch { return clean(value).replace(/\/$/,'').toLowerCase(); }
}

function slugTitle(raw: string) {
  return identityTitle(decodeURIComponent(raw)
    .replace(/\.html?$/i,'')
    .replace(/^buy-/i,'')
    .replace(/-p-?\d+.*$/i,'')
    .replace(/-p\d+.*$/i,'')
    .replace(/c\d+p\d+.*$/i,'')
    .replace(/[-_]+/g,' '));
}

function titleFromUrl(url: string) {
  try {
    const u=new URL(url);
    const h=u.hostname.toLowerCase();
    if (h.includes('next.')) return '';
    const parts=u.pathname.split('/').filter(Boolean);
    const p=parts.findIndex(x=>x.toLowerCase()==='p');
    if ((h.includes('maxfashion')||h.includes('centrepoint')) && p>0) return slugTitle(parts[p-1]);
    if (h.includes('adidas') && parts.length>1) return slugTitle(parts[parts.length-2]);
    if (h.includes('hm.com') && /productpage/i.test(parts.at(-1)||'')) return '';
    if (h.includes('marksandspencer')) {
      const candidate=parts.find(x=>x.includes('-')) || parts.at(-1) || '';
      return slugTitle(candidate);
    }
    return slugTitle(parts.at(-1)||'');
  } catch { return ''; }
}

async function loadRows() {
  const out: SourceRow[]=[];
  for (let i=0;i<SHEETS.length;i+=4) {
    const batch=SHEETS.slice(i,i+4);
    const results=await Promise.all(batch.map(async s=>{
      const sheetUrl=`https://docs.google.com/spreadsheets/d/${s.id}/edit?gid=${s.gid}`;
      try { return {s,sheetUrl,rows:(await loadGoogleSheetRows(sheetUrl)).rows}; }
      catch { return {s,sheetUrl,rows:[] as GoogleSheetRow[]}; }
    }));
    for (const r of results) for (const row of r.rows) {
      if (!clean(row.url)) continue;
      const url=canonicalUrl(row.url);
      const vk=vendorFromUrl(url);
      const tk=titleFromUrl(url);
      if (!vk||!tk) continue;
      out.push({...row,canonicalUrl:url,vendorKey:vk,titleKey:tk,spreadsheetId:r.s.id,spreadsheetName:r.s.name,sheetName:r.s.tab,gid:r.s.gid,sheetUrl:r.sheetUrl});
    }
  }
  return out;
}

async function runWorker() {
  const job=await prisma.syncJob.create({data:{type:JOB_TYPE,status:'running',startedAt:new Date(),result:JSON.stringify({stage:'loading'})}});
  let processed=0,linked=0,failed=0;
  try {
    const [sources,unresolved]=await Promise.all([
      loadRows(),
      prisma.$queryRawUnsafe<CacheRow[]>(`SELECT "shopifyId","title","vendor","matchStatus" FROM "${CACHE_TABLE}" WHERE UPPER(COALESCE("status",''))='ACTIVE' AND "matchStatus" IN ('needs_link','needs_review') ORDER BY "shopifyId" ASC LIMIT ${LIMIT}`),
    ]);
    const index=new Map<string,SourceRow[]>();
    for (const s of sources) {
      const k=`${s.vendorKey}|${s.titleKey}`;
      index.set(k,[...(index.get(k)||[]),s]);
    }
    const candidates:Array<{cache:CacheRow,row:SourceRow}>=[];
    for (const cache of unresolved) {
      const vk=vendorKey(cache.vendor), tk=identityTitle(cache.title);
      if (!vk||!tk) continue;
      const matches=index.get(`${vk}|${tk}`)||[];
      const urls=[...new Set(matches.map(x=>x.canonicalUrl))];
      if (urls.length!==1) continue;
      const row=matches.find(x=>x.canonicalUrl===urls[0]);
      if (row) candidates.push({cache,row});
    }
    console.log(`[url-title-match] sourceTitles=${sources.length} unresolved=${unresolved.length} candidates=${candidates.length}`);
    const client=await ShopifyService.getClientFromDb(prisma);
    for (let i=0;i<candidates.length;i+=CONCURRENCY) {
      await Promise.all(candidates.slice(i,i+CONCURRENCY).map(async ({cache,row})=>{
        processed++;
        try {
          const live=await ShopifyService.getProductCatalogSnapshot(client,cache.shopifyId);
          if (!live||String(live.status).toUpperCase()!=='ACTIVE') throw new Error('missing/inactive');
          if (vendorKey(live.vendor)!==row.vendorKey) throw new Error('vendor mismatch');
          if (identityTitle(live.title)!==row.titleKey) throw new Error('title mismatch');
          await prisma.$executeRawUnsafe(`UPDATE "${CACHE_TABLE}" SET "matchStatus"='linked',"matchMethod"='unique_source_url_title_vendor',"matchedSourceUrl"=$2,"sheetSpreadsheetId"=$3,"sheetSpreadsheetName"=$4,"sheetName"=$5,"sheetGid"=$6,"sheetRowNumber"=$7,"sheetSku"=$8,"sheetMultiplier"=$9,"reason"='Unique source URL title + vendor verified against live Shopify; variants pending',"evidence"=$10,"updatedAt"=NOW() WHERE "shopifyId"=$1 AND "matchStatus" IN ('needs_link','needs_review')`,live.id,row.canonicalUrl,row.spreadsheetId,row.spreadsheetName,row.sheetName,row.gid,row.rowNumber,clean(row.sku)||null,Number(row.priceMultiplier||0)||null,JSON.stringify(['unique_source_url_title','exact_vendor','live_shopify_readback']));
          linked++;
        } catch { failed++; }
      }));
      if (processed%25<CONCURRENCY||i+CONCURRENCY>=candidates.length) {
        await prisma.syncJob.update({where:{id:job.id},data:{result:JSON.stringify({stage:'linking',sourceTitles:sources.length,unresolved:unresolved.length,candidates:candidates.length,processed,linked,failed,scraperApiCreditsUsed:0})}});
        console.log(`[url-title-match] processed=${processed}/${candidates.length} linked=${linked} failed=${failed}`);
      }
    }
    await prisma.syncJob.update({where:{id:job.id},data:{status:'completed',completedAt:new Date(),result:JSON.stringify({stage:'completed',sourceTitles:sources.length,unresolved:unresolved.length,candidates:candidates.length,processed,linked,failed,scraperApiCreditsUsed:0})}});
    console.log(`[url-title-match] completed linked=${linked} failed=${failed}`);
  } catch (e:any) {
    await prisma.syncJob.update({where:{id:job.id},data:{status:'failed',completedAt:new Date(),result:JSON.stringify({stage:'failed',processed,linked,failed,error:clean(e?.message||e),scraperApiCreditsUsed:0})}}).catch(()=>undefined);
    console.error('[url-title-match] failed',e);
  }
}

if (enabled('CATALOG_URL_TITLE_MATCH_AUTOSTART',false)) setTimeout(()=>void runWorker(),4000);
else console.log('[url-title-match] autostart disabled');
