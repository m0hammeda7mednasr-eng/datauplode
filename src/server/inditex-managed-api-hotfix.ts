import axios from 'axios';
import { fetchHtmlViaManagedBypass } from './services/scraper.js';

let installed = false;

function clean(value: unknown) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim();
}

function isInditexProductApi(url: unknown) {
  const value = clean(url).toLowerCase();
  return (
    value.includes('zara.com/ae/en/products-details') ||
    (value.includes('lefties.com/itxrest/') && value.includes('/productsarray'))
  );
}

function firstProduct(data: any) {
  if (Array.isArray(data)) return data[0];
  if (Array.isArray(data?.products)) return data.products[0];
  return data;
}

function hasProductColors(data: any) {
  return Array.isArray(firstProduct(data)?.detail?.colors) && firstProduct(data).detail.colors.length > 0;
}

function parseJsonBody(body: string) {
  const text = clean(body);
  if (!text) throw new Error('managed Inditex API returned an empty body');
  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    const starts = [firstBrace, firstBracket].filter((value) => value >= 0);
    const start = starts.length ? Math.min(...starts) : -1;
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('managed Inditex API did not return JSON');
  }
}

export function installInditexManagedApiHotfix() {
  if (installed) return;
  installed = true;

  const originalGet = axios.get.bind(axios);
  (axios as any).get = async function inditexManagedGet(url: any, config?: any) {
    if (!isInditexProductApi(url)) return originalGet(url, config);

    let originalResponse: any = null;
    let originalError: any = null;
    try {
      originalResponse = await originalGet(url, config);
      if (hasProductColors(originalResponse?.data)) return originalResponse;
    } catch (error: any) {
      originalError = error;
    }

    try {
      const body = await fetchHtmlViaManagedBypass(String(url), {
        deviceType: 'desktop',
        jsRender: false,
        premium: true,
      });
      const data = parseJsonBody(body);
      if (!hasProductColors(data)) {
        throw new Error('managed Inditex API response did not expose product colors');
      }
      console.log(`[inditex-hotfix] managed API recovery succeeded for ${String(url).includes('zara.com') ? 'Zara' : 'Lefties'}`);
      return {
        ...(originalResponse || {}),
        data,
        status: 200,
        statusText: 'OK',
      };
    } catch (bypassError: any) {
      console.warn(`[inditex-hotfix] managed API recovery failed: ${clean(bypassError?.message || bypassError)}`);
      if (originalResponse) return originalResponse;
      throw originalError || bypassError;
    }
  };

  console.log('[inditex-hotfix] Zara/Lefties managed API recovery installed');
}

installInditexManagedApiHotfix();
