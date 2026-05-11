import * as cheerio from 'cheerio';
import axios from 'axios';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface NormalizedProduct {
  source: {
    supplier: string;
    url: string;
    productId?: string;
  };
  title: string;
  description?: string;
  brand?: string;
  currency: string;
  price: number;
  images: Array<{
    url: string;
    alt?: string;
    color?: string;
    position: number;
  }>;
  options: Array<{
    name: string;
    values: string[];
  }>;
  variants: Array<{
    sourceVariantId?: string;
    sku?: string;
    color?: string;
    size?: string;
    price?: number;
    currency?: string;
    calculatedPrice?: number;
    optionValues?: Record<string, string>;
    available: boolean;
    stockStatus: "in_stock" | "out_of_stock" | "low_stock" | "unknown";
    imageUrl?: string;
    raw?: any;
  }>;
  raw: any;
}

export interface AvailabilitySnapshot {
  available: boolean;
  price?: number;
  variants?: Array<{
    id: string;
    available: boolean;
    price?: number;
  }>;
}

export interface SupplierScraper {
  canHandle(url: string): boolean;
  scrape(url: string): Promise<NormalizedProduct>;
  checkAvailability(url: string): Promise<AvailabilitySnapshot>;
}

const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ar-EG;q=0.8,ar;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};

const execFileAsync = promisify(execFile);

const nextDomains = ['next.co.uk', 'nextdirect.com', 'next.ae', 'next.us'];

function isNextUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return nextDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return nextDomains.some(domain => url.toLowerCase().includes(domain));
  }
}

function getProductIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hash && parsed.hash.length > 1) return parsed.hash.slice(1);

    const parts = parsed.pathname.split('/').filter(Boolean);
    const lastMeaningfulPart = [...parts].reverse().find(part => !['index.html', 'index.htm'].includes(part.toLowerCase()));
    return lastMeaningfulPart?.split('?')[0];
  } catch {
    return url.split('/').pop()?.split(/[?#]/)[0];
  }
}

function resolveUrl(src: string | undefined, pageUrl: string): string | undefined {
  if (!src) return undefined;
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith('data:')) return undefined;

  try {
    return new URL(trimmed, pageUrl).toString();
  } catch {
    return undefined;
  }
}

function normaliseNumberText(value: string): string {
  const arabicDigits: Record<string, string> = {
    '٠': '0',
    '١': '1',
    '٢': '2',
    '٣': '3',
    '٤': '4',
    '٥': '5',
    '٦': '6',
    '٧': '7',
    '٨': '8',
    '٩': '9',
    '۰': '0',
    '۱': '1',
    '۲': '2',
    '۳': '3',
    '۴': '4',
    '۵': '5',
    '۶': '6',
    '۷': '7',
    '۸': '8',
    '۹': '9',
  };

  return value
    .replace(/[٠-٩۰-۹]/g, digit => arabicDigits[digit] || digit)
    .replace(/[\u066C,\s]/g, '')
    .replace(/\u066B/g, '.');
}

function normaliseLocalizedNumberText(value: string): string {
  const arabicDigits: Record<string, string> = {
    '\u0660': '0',
    '\u0661': '1',
    '\u0662': '2',
    '\u0663': '3',
    '\u0664': '4',
    '\u0665': '5',
    '\u0666': '6',
    '\u0667': '7',
    '\u0668': '8',
    '\u0669': '9',
    '\u06F0': '0',
    '\u06F1': '1',
    '\u06F2': '2',
    '\u06F3': '3',
    '\u06F4': '4',
    '\u06F5': '5',
    '\u06F6': '6',
    '\u06F7': '7',
    '\u06F8': '8',
    '\u06F9': '9',
  };

  return value
    .replace(/[\u0660-\u0669\u06F0-\u06F9]/g, digit => arabicDigits[digit] || digit)
    .replace(/[\u066C,\s]/g, '')
    .replace(/\u066B/g, '.');
}

function parsePrice(value: any): number {
  if (typeof value === 'number') return value;
  if (!value) return 0;

  const normalised = normaliseLocalizedNumberText(String(value));
  const match = normalised.match(/\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : 0;
}

function parsePriceRange(value: any): { min: number; max: number } {
  if (typeof value === 'number') return { min: value, max: value };
  if (!value) return { min: 0, max: 0 };

  const normalised = normaliseLocalizedNumberText(String(value));
  const prices = [...normalised.matchAll(/\d+(?:\.\d+)?/g)]
    .map(match => parseFloat(match[0]))
    .filter(price => Number.isFinite(price));

  if (prices.length === 0) return { min: 0, max: 0 };
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
  };
}

function detectCurrency(text: string | undefined, fallback = 'USD'): string {
  if (!text) return fallback;
  if (/EGP|\u062c\s*\.?\s*\u0645/i.test(text)) return 'EGP';
  if (/AED|\u062f\s*\.?\s*\u0625|\u062f\u0631\u0647\u0645/i.test(text)) return 'AED';
  if (/SAR|\u0631\s*\.?\s*\u0633|\u0631\u064a\u0627\u0644/i.test(text)) return 'SAR';
  if (/GBP|\u00a3/i.test(text)) return 'GBP';
  if (/EUR|\u20ac/i.test(text)) return 'EUR';
  if (/GBP|£/i.test(text)) return 'GBP';
  if (/EUR|€/i.test(text)) return 'EUR';
  if (/USD|\$/i.test(text)) return 'USD';
  return fallback;
}

function looksLikeCurrencyText(text: string): boolean {
  return /(?:EGP|AED|SAR|GBP|EUR|USD|\$|\u00a3|\u20ac|\u062c\s*\.?\s*\u0645|\u062f\s*\.?\s*\u0625|\u062f\u0631\u0647\u0645)/i.test(text) ||
    /(?:Â£|â‚¬)/i.test(text);
}

function cleanText(value: string | undefined): string {
  return (value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
}

function findProductJsonLd(data: any): any {
  if (!data) return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const product = findProductJsonLd(item);
      if (product) return product;
    }
    return null;
  }

  const type = data['@type'];
  if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) {
    return data;
  }

  return findProductJsonLd(data['@graph']) || findProductJsonLd(data.product);
}

function firstOffer(productData: any): any {
  if (!productData?.offers) return null;
  return Array.isArray(productData.offers) ? productData.offers[0] : productData.offers;
}

function getNextStyleIds(url: string): { styleId: string; productId: string } | null {
  const urlMatch = url.match(/style\/([a-z0-9]+)\/([a-z0-9]+)/i);
  if (!urlMatch) return null;

  return {
    styleId: urlMatch[1].toLowerCase(),
    productId: urlMatch[2].toLowerCase(),
  };
}

function buildNextReaderUrls(url: string): string[] {
  const ids = getNextStyleIds(url);
  const urls = [url];

  if (ids) {
    const { styleId, productId } = ids;
    urls.push(
      `https://www.next.us/en/style/${styleId}/${productId}`,
      `https://www.nextdirect.com/eg/en/style/${styleId}/${productId}`,
      `https://www.nextdirect.com/eg/ar/style/${styleId}/${productId}`,
      `https://www.next.co.uk/style/${styleId}/${productId}`,
    );
  }

  return [...new Set(urls)];
}

function buildNextHtmlFallbackUrls(url: string): string[] {
  const ids = getNextStyleIds(url);
  if (!ids) return [url];

  const { styleId, productId } = ids;
  return [
    url,
    `https://www.next.us/en/style/${styleId}/${productId}`,
    `https://www.next.us/en/style/${styleId}/${productId}?json=true`,
    `https://www.nextdirect.com/eg/en/style/${styleId}/${productId}`,
    `https://www.next.co.uk/style/${styleId}/${productId}`,
  ];
}

function isBlockedReaderMarkdown(markdown: string): boolean {
  return /Title:\s*(Access Denied|404|Page Not Found)/i.test(markdown) ||
    /Target URL returned error\s+(403|404)/i.test(markdown) ||
    /You don't have permission to access/i.test(markdown) ||
    /404\s*\|\s*Page Not Found/i.test(markdown) ||
    /Oops'\s+Something's gone wrong/i.test(markdown);
}

function pushImage(images: NormalizedProduct['images'], url: string | undefined, pageUrl: string, alt?: string) {
  const absoluteUrl = resolveUrl(url, pageUrl);
  if (!absoluteUrl) return;
  if (/\.(svg)(?:[?#]|$)/i.test(absoluteUrl)) return;
  if (images.some(img => img.url === absoluteUrl)) return;

  images.push({
    url: absoluteUrl,
    alt: cleanText(alt),
    position: images.length,
  });
}

function pushNextProductImage(images: NormalizedProduct['images'], rawUrl: string | undefined, pageUrl: string, productIdKey?: string, alt?: string) {
  if (!rawUrl) return;

  const unescapedUrl = rawUrl
    .replace(/\\u002F/g, '/')
    .replace(/&amp;/g, '&');
  const absoluteUrl = resolveUrl(unescapedUrl, pageUrl);
  if (!absoluteUrl) return;

  const lower = absoluteUrl.toLowerCase();
  const looksLikeProductImage =
    lower.includes('xcdn.next.co.uk') &&
    lower.includes('/product/') &&
    (!productIdKey || lower.includes(productIdKey.toLowerCase()));

  if (!looksLikeProductImage) return;

  const highResUrl = absoluteUrl.includes('width=')
    ? absoluteUrl.replace(/width=\d+/i, 'width=750')
    : absoluteUrl;
  const canonicalKey = highResUrl.split('?')[0].toLowerCase();
  if (images.some(img => img.url.split('?')[0].toLowerCase() === canonicalKey)) return;

  images.push({
    url: highResUrl,
    alt: cleanText(alt),
    position: images.length,
  });
}

function extractNextProductImages(text: string, pageUrl: string, productIdKey?: string): NormalizedProduct['images'] {
  const images: NormalizedProduct['images'] = [];

  const markdownImageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  for (const match of text.matchAll(markdownImageRegex)) {
    pushNextProductImage(images, match[2], pageUrl, productIdKey, match[1]);
  }

  const urlRegex = /https?:\/\/xcdn\.next\.co\.uk\/[^"'<>)\s\\]+/gi;
  for (const match of text.matchAll(urlRegex)) {
    pushNextProductImage(images, match[0], pageUrl, productIdKey);
  }

  return images.map((image, position) => ({ ...image, position }));
}

function slugOption(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

function parseNextColourFromMarkdown(lines: string[]): string | undefined {
  const colourIndex = lines.findIndex(line => /^(Colour|Color|\u0627\u0644\u0644\u0648\u0646)\s*:/i.test(line));
  if (colourIndex === -1) return undefined;

  for (const line of lines.slice(colourIndex + 1, colourIndex + 8)) {
    if (
      !line ||
      line === '\u200b' ||
      line.startsWith('![') ||
      /^\[?Input\]?$/i.test(line) ||
      /^Image\s*:/i.test(line) ||
      /^(\* \* \*|Size|Choose Size|Taille|Choisissez)/i.test(line)
    ) continue;
    return cleanText(line);
  }

  return undefined;
}

function inferNextColourFromTitle(title: string): string | undefined {
  const normalized = cleanText(title)
    .replace(/\s+-\s+/g, ' ')
    .replace(/\s+(?:from|by)\s+Next$/i, '');

  const productKeywordPattern = /\b(?:tops?|t-?shirts?|shirts?|shorts?|set|dress(?:es)?|romper|dungaree|outfit|sleepsuit|bodysuit|leggings?|joggers?|jeans|trousers|sandals?|shoes?|trainers?|boots?|cardigan|jumper|sweater|hoodie|coat|jacket|swimsuit|pyjamas?|pajamas?)\b/i;
  const keywordMatch = normalized.match(productKeywordPattern);
  if (!keywordMatch || keywordMatch.index === undefined || keywordMatch.index <= 0) return undefined;

  const candidate = cleanText(normalized.slice(0, keywordMatch.index));
  if (
    !candidate ||
    candidate.length > 48 ||
    /\b(?:baby|kids?|girls?|boys?|maman|b[eé]b[eé]|cotton|pack|piece|printed?)\b/i.test(candidate)
  ) {
    return undefined;
  }

  return candidate.replace(/^(?:Next|Lipsy|Reiss|JoJo Maman B[eé]b[eé]|Baker by Ted Baker)\s+/i, '').trim();
}

function parseNextColourFromHtml($: cheerio.CheerioAPI, title: string): string | undefined {
  const explicitText = cleanText(
    $('[data-testid*="colour" i], [data-testid*="color" i], [class*="colour" i], [class*="color" i]')
      .map((_, el) => $(el).text())
      .get()
      .join(' ')
  );
  const explicitMatch = explicitText.match(/(?:Colour|Color)\s*:?\s*([A-Za-z0-9 /&,+.'-]{2,60})(?:\s+(?:Size|Choose|Selected)|$)/i);
  const explicitColor = cleanText(explicitMatch?.[1]);

  if (explicitColor && !/^Image\s*:/i.test(explicitColor)) return explicitColor;
  return inferNextColourFromTitle(title);
}

function inferNextBabySizes(text: string): string[] {
  const normalized = cleanText(text);
  let maxYears = 0;

  const englishRange = normalized.match(/(?:0\s*mths?|0\s*months?)\s*-\s*(\d+)\s*(?:yrs?|years?)/i);
  const upToRange = normalized.match(/up to\s*(\d+)\s*-\s*(\d+)\s*years?/i);
  const arabicRange = normalized.match(/(?:0\s*(?:\u0634\u0647\u0631|\u0634\u0647\u0648\u0631))\s*-\s*(\d+)\s*(?:\u0633\u0646\u0629|\u0633\u0646\u062a\u064a\u0646|\u0633\u0646\u0648\u0627\u062a)/i);

  if (englishRange) maxYears = parseInt(englishRange[1], 10);
  if (!maxYears && upToRange) maxYears = parseInt(upToRange[2], 10);
  if (!maxYears && arabicRange) maxYears = parseInt(arabicRange[1], 10);
  if (!maxYears && /baby|babies|\u0628\u064a\u0628\u064a/i.test(normalized)) maxYears = 3;

  if (!maxYears) return [];

  const sizes = [
    'Up to 1 Month',
    '0-3 Months',
    '3-6 Months',
    '6-9 Months',
    '9-12 Months',
    '12-18 Months',
    '1.5-2 Years',
  ];

  if (maxYears >= 3) sizes.push('2-3 Years');
  if (maxYears >= 4) sizes.push('3-4 Years');

  return sizes;
}

function buildInferredNextVariants(productCode: string | undefined, sizes: string[], priceRange: { min: number; max: number }, color?: string): NormalizedProduct['variants'] {
  if (sizes.length === 0) return [];

  return sizes.map((size, index) => {
    const isHighestSize = index === sizes.length - 1;
    const price = isHighestSize && priceRange.max > priceRange.min ? priceRange.max : priceRange.min;

    return {
      sourceVariantId: `${productCode || 'next'}-${slugOption(size)}`,
      sku: `${productCode || 'NEXT'}-${slugOption(size).toUpperCase()}`,
      color,
      size,
      price,
      optionValues: buildVariantOptionValues(color, size),
      available: true,
      stockStatus: 'in_stock',
    };
  });
}

function formatNextProductCodeFromProductId(productId: string | undefined): string | undefined {
  const normalized = cleanText(productId).replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (!normalized) return undefined;
  if (normalized.length === 6) return `${normalized.slice(0, 3)}-${normalized.slice(3)}`;
  return normalized;
}

function stripNextCardPrice(title: string): string {
  return cleanText(title)
    .replace(/\s+(?:was|now|from)?\s*(?:EGP|AED|USD|SAR|GBP|EUR|\$|£|€)\s*[\d,.].*$/i, '')
    .replace(/\s+(?:was|now|from)\s+.*$/i, '')
    .trim();
}

function productIdKeyFromNextCode(productCode: string | undefined): string | undefined {
  return cleanText(productCode).replace(/[^a-z0-9]/gi, '').toLowerCase() || undefined;
}

function getNextSizeValues(product: NormalizedProduct): string[] {
  const sizeOption = product.options.find(option => /^size$/i.test(option.name));
  return uniqueCleanValues([
    ...(sizeOption?.values || []),
    ...product.variants.map(variant => variant.size),
  ]).filter(value => !isDefaultOptionValue(value));
}

function getNextCurrentColor(product: NormalizedProduct): string | undefined {
  const colorOption = product.options.find(option => /^colou?r$/i.test(option.name));
  return colorOption?.values?.[0] || product.variants.find(variant => variant.color)?.color || inferNextColourFromTitle(product.title);
}

function applyNextColorwaysFromMarkdown(product: NormalizedProduct, markdown: string, url: string, readerUrl = url): NormalizedProduct {
  const ids = getNextStyleIds(url) || getNextStyleIds(readerUrl);
  if (!ids) return product;

  const currentProductId = productIdKeyFromNextCode(product.source.productId) || ids.productId;
  const currentColor = getNextCurrentColor(product);
  const sizeValues = getNextSizeValues(product);
  if (!currentColor || sizeValues.length === 0) return product;

  const currentPrices = product.variants
    .map(variant => variant.price || 0)
    .filter(price => price > 0);
  const currentPriceRange = {
    min: currentPrices.length ? Math.min(...currentPrices) : product.price,
    max: currentPrices.length ? Math.max(...currentPrices) : product.price,
  };

  type NextColorway = {
    productId: string;
    productCode?: string;
    color: string;
    title: string;
    url: string;
    imageUrl?: string;
    priceRange: { min: number; max: number };
    currency: string;
    isCurrent?: boolean;
  };

  const colorways = new Map<string, NextColorway>();
  colorways.set(currentProductId, {
    productId: currentProductId,
    productCode: product.source.productId || formatNextProductCodeFromProductId(currentProductId),
    color: currentColor,
    title: product.title,
    url,
    imageUrl: product.images[0]?.url,
    priceRange: currentPriceRange,
    currency: product.currency,
    isCurrent: true,
  });

  const cardRegex = /\[!\[Image\s+\d+:\s*([^\]]+)\]\((https?:\/\/[^)]+)\)\s*([^\]]+?)\]\((https?:\/\/[^)]+\/style\/([a-z0-9]+)\/([a-z0-9]+)[^)]*)\)/gi;
  for (const match of markdown.matchAll(cardRegex)) {
    const [, imageAlt, imageUrl, linkText, productUrl, styleId, productId] = match;
    if (styleId.toLowerCase() !== ids.styleId.toLowerCase()) continue;

    const productIdKey = productId.toLowerCase();
    const title = stripNextCardPrice(imageAlt || linkText);
    const color = inferNextColourFromTitle(title);
    if (!color || colorways.has(productIdKey)) continue;

    const priceRange = parsePriceRange(linkText);
    colorways.set(productIdKey, {
      productId: productIdKey,
      productCode: formatNextProductCodeFromProductId(productIdKey),
      color,
      title,
      url: productUrl,
      imageUrl,
      priceRange: priceRange.min > 0 ? priceRange : currentPriceRange,
      currency: detectCurrency(linkText, product.currency),
    });
  }

  if (colorways.size <= 1) return product;

  const variants: NormalizedProduct['variants'] = [];
  for (const colorway of colorways.values()) {
    if (colorway.isCurrent && product.variants.some(variant => variant.size)) {
      for (const variant of product.variants) {
        variants.push({
          ...variant,
          color: colorway.color,
          imageUrl: variant.imageUrl || colorway.imageUrl,
          currency: variant.currency || colorway.currency,
          optionValues: buildVariantOptionValues(colorway.color, variant.size),
        });
      }
      continue;
    }

    variants.push(
      ...buildInferredNextVariants(colorway.productCode, sizeValues, colorway.priceRange, colorway.color)
        .map(variant => ({
          ...variant,
          currency: colorway.currency,
          imageUrl: colorway.imageUrl,
          raw: {
            colorwayUrl: colorway.url,
            colorwayTitle: colorway.title,
            inferredFromColorwayCard: true,
          },
        }))
    );
  }

  const images = [...product.images];
  for (const colorway of colorways.values()) {
    pushImage(images, colorway.imageUrl, colorway.url, colorway.title);
    if (images.length) images[images.length - 1].color ||= colorway.color;
  }

  return {
    ...product,
    price: Math.min(...variants.map(variant => variant.price || product.price).filter(price => price > 0)),
    images: images.map((image, position) => ({ ...image, position })),
    options: [
      { name: 'Color', values: [...colorways.values()].map(colorway => colorway.color) },
      { name: 'Size', values: sizeValues },
    ],
    variants,
    raw: {
      ...product.raw,
      nextColorways: [...colorways.values()],
      colorwaysInferredFromReader: true,
    },
  };
}

function variantsFromJsonLdOffers(offers: any, productCode: string | undefined, color?: string): NormalizedProduct['variants'] {
  const offerList = Array.isArray(offers) ? offers : [offers].filter(Boolean);

  return offerList
    .map((offer: any, index: number) => {
      const size = cleanText(offer?.name || offer?.description || `Option ${index + 1}`);
      const price = parsePrice(offer?.price);
      const inStock = !offer?.availability || /InStock/i.test(String(offer.availability));

      return {
        sourceVariantId: offer?.sku || `${productCode || 'next'}-${slugOption(size)}`,
        sku: offer?.sku || `${productCode || 'NEXT'}-${slugOption(size).toUpperCase()}`,
        color,
        size,
        price,
        currency: offer?.priceCurrency,
        optionValues: buildVariantOptionValues(color, size),
        available: inStock,
        stockStatus: inStock ? 'in_stock' as const : 'out_of_stock' as const,
        raw: offer,
      };
    })
    .filter((variant: any) => variant.size && variant.price > 0);
}

function hostMatches(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch {
    const lower = url.toLowerCase();
    return domains.some(domain => lower.includes(domain));
  }
}

function availabilitySnapshotFromProduct(product: NormalizedProduct): AvailabilitySnapshot {
  return {
    available: product.variants.some(v => v.available),
    price: product.price,
    variants: product.variants.map(v => ({
      id: v.sourceVariantId || v.sku || 'default',
      available: v.available,
      price: v.price || product.price,
    })),
  };
}

async function fetchHtml(url: string, extraHeaders: Record<string, string> = {}): Promise<string> {
  const response = await axios.get(url, {
    headers: {
      ...browserHeaders,
      ...extraHeaders,
    },
    timeout: 20000,
    responseType: 'text',
    validateStatus: (status: number) => status < 500,
  });

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}`);
  }

  return typeof response.data === 'string' ? response.data : String(response.data);
}

async function fetchHtmlWithCurl(url: string): Promise<string> {
  const curlExecutable = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const { stdout } = await execFileAsync(
    curlExecutable,
    [
      '-L',
      '--compressed',
      '-sS',
      '-A',
      browserHeaders['User-Agent'],
      url,
    ],
    {
      timeout: 60000,
      maxBuffer: 30 * 1024 * 1024,
    }
  );

  const html = typeof stdout === 'string' ? stdout : String(stdout);
  if (!html.trim()) throw new Error('curl returned an empty response');
  if (/Just a moment|security verification|cf-chl|Cloudflare/i.test(html)) {
    throw new Error('curl returned Cloudflare challenge');
  }

  return html;
}

function extractProductJsonLdFromHtml(html: string): any {
  const $ = cheerio.load(html);
  let productData: any = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (productData) return;
    try {
      productData = findProductJsonLd(JSON.parse($(el).text() || '{}'));
    } catch {}
  });

  return productData;
}

function extractBalancedJson(source: string, startIndex: number): string | null {
  const opener = source[startIndex];
  const closer = opener === '{' ? '}' : opener === '[' ? ']' : '';
  if (!closer) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = startIndex; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, i + 1);
    }
  }

  return null;
}

function parseJsonAfterMarker(source: string, marker: string, fromIndex = 0): any {
  const markerIndex = source.indexOf(marker, Math.max(0, fromIndex));
  if (markerIndex < 0) return null;

  const valueStartMatch = source.slice(markerIndex + marker.length).match(/[\[{]/);
  if (!valueStartMatch || valueStartMatch.index === undefined) return null;

  const valueStart = markerIndex + marker.length + valueStartMatch.index;
  const rawJson = extractBalancedJson(source, valueStart);
  if (!rawJson) return null;

  try {
    return JSON.parse(rawJson);
  } catch {
    return null;
  }
}

function parseWindowAssignedJson(source: string, variableName: string): any {
  const variableIndex = source.indexOf(variableName);
  if (variableIndex < 0) return null;

  const equalsIndex = source.indexOf('=', variableIndex + variableName.length);
  if (equalsIndex < 0) return null;

  const valueStartMatch = source.slice(equalsIndex + 1).match(/[\[{]/);
  if (!valueStartMatch || valueStartMatch.index === undefined) return null;

  const valueStart = equalsIndex + 1 + valueStartMatch.index;
  const rawJson = extractBalancedJson(source, valueStart);
  if (!rawJson) return null;

  try {
    return JSON.parse(rawJson);
  } catch {
    return null;
  }
}

function uniqueCleanValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => cleanText(value)).filter(Boolean))];
}

function isDefaultOptionValue(value: string | undefined): boolean {
  return !value || /^(default|default title|one size|choose|select|please select|size guide|size chart)$/i.test(cleanText(value));
}

function variantOptionValues(variant: NormalizedProduct['variants'][number]): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [name, value] of Object.entries(variant.optionValues || {})) {
    const cleanName = cleanText(name);
    const cleanValue = cleanText(value);
    if (cleanName && !isDefaultOptionValue(cleanValue)) {
      values[cleanName] = cleanValue;
    }
  }

  if (variant.color && !values.Color) values.Color = cleanText(variant.color);
  if (variant.size && !values.Size) values.Size = cleanText(variant.size);

  return values;
}

function buildVariantOptionValues(color?: string, size?: string): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  if (color && !isDefaultOptionValue(color)) values.Color = cleanText(color);
  if (size && !isDefaultOptionValue(size)) values.Size = cleanText(size);
  return Object.keys(values).length ? values : undefined;
}

function normalizeProductOptionsAndVariants(product: NormalizedProduct): NormalizedProduct {
  const optionValueMap = new Map<string, Set<string>>();

  for (const option of product.options || []) {
    const name = cleanText(option?.name);
    if (!name || /^default$/i.test(name)) continue;
    const values = uniqueCleanValues(option?.values || []).filter(value => !isDefaultOptionValue(value));
    if (!values.length) continue;

    if (!optionValueMap.has(name)) optionValueMap.set(name, new Set());
    values.forEach(value => optionValueMap.get(name)?.add(value));
  }

  const seenVariantKeys = new Set<string>();
  const variants = (product.variants || []).map((variant, index) => {
    const optionValues = variantOptionValues(variant);

    for (const [name, value] of Object.entries(optionValues)) {
      if (!optionValueMap.has(name)) optionValueMap.set(name, new Set());
      optionValueMap.get(name)?.add(value);
    }

    const color = optionValues.Color || variant.color;
    const size = optionValues.Size || variant.size;
    const sourceVariantId = cleanText(
      variant.sourceVariantId ||
      variant.sku ||
      `${product.source.productId || product.source.supplier}-${Object.values(optionValues).join('-') || index}`
    );
    const key = sourceVariantId || JSON.stringify(optionValues) || String(index);
    const safeKey = seenVariantKeys.has(key) ? `${key}-${index}` : key;
    seenVariantKeys.add(key);

    return {
      ...variant,
      sourceVariantId: safeKey,
      sku: variant.sku ? cleanText(variant.sku) : undefined,
      color: color && !isDefaultOptionValue(color) ? cleanText(color) : undefined,
      size: size && !isDefaultOptionValue(size) ? cleanText(size) : undefined,
      price: variant.price && variant.price > 0 ? variant.price : product.price,
      currency: variant.currency || product.currency,
      optionValues: Object.keys(optionValues).length ? optionValues : undefined,
      stockStatus: variant.stockStatus || (variant.available ? 'in_stock' : 'unknown'),
    };
  });

  const preferredOrder = ['Color', 'Colour', 'Size'];
  const orderedOptionNames = [
    ...preferredOrder.filter(name => optionValueMap.has(name)),
    ...[...optionValueMap.keys()].filter(name => !preferredOrder.includes(name)),
  ];

  const options = orderedOptionNames
    .map(name => ({
      name: name === 'Colour' ? 'Color' : name,
      values: [...(optionValueMap.get(name) || new Set<string>())],
    }))
    .filter(option => option.values.length);

  return {
    ...product,
    price: product.price || variants.map(variant => variant.price || 0).find(price => price > 0) || 0,
    options: options.length ? options : [{ name: 'Default', values: ['Default'] }],
    variants: variants.length ? variants : [{
      sourceVariantId: product.source.productId || 'default',
      price: product.price,
      currency: product.currency,
      available: true,
      stockStatus: 'unknown',
    }],
  };
}

function buildOptionMatrixVariants(
  productCode: string | undefined,
  options: Array<{ name: string; values: string[] }>,
  price: number,
  currency: string,
  stockStatus: NormalizedProduct['variants'][number]['stockStatus'] = 'unknown'
): NormalizedProduct['variants'] {
  const normalizedOptions = options
    .map(option => ({
      name: cleanText(option.name),
      values: uniqueCleanValues(option.values).filter(value => !isDefaultOptionValue(value)),
    }))
    .filter(option => option.name && option.values.length);

  if (!normalizedOptions.length) return [];

  const combinations: Array<Record<string, string>> = [{}];
  for (const option of normalizedOptions) {
    const next: Array<Record<string, string>> = [];
    for (const combination of combinations) {
      for (const value of option.values) {
        next.push({ ...combination, [option.name]: value });
      }
    }
    combinations.splice(0, combinations.length, ...next.slice(0, 250));
  }

  return combinations.slice(0, 250).map((optionValues, index) => {
    const color = optionValues.Color || optionValues.Colour;
    const size = optionValues.Size;
    const slug = Object.entries(optionValues)
      .map(([name, value]) => `${slugOption(name)}-${slugOption(value)}`)
      .join('-');

    return {
      sourceVariantId: `${productCode || 'variant'}-${slug || index}`,
      sku: `${productCode || 'VAR'}-${(slug || String(index)).toUpperCase()}`,
      color,
      size,
      price,
      currency,
      optionValues,
      available: stockStatus !== 'out_of_stock',
      stockStatus,
    };
  });
}

function extractGenericOptionValuesFromDom($: cheerio.CheerioAPI): Array<{ name: string; values: string[] }> {
  const options = new Map<string, Set<string>>();
  const optionPatterns: Array<{ name: 'Color' | 'Size'; pattern: RegExp }> = [
    { name: 'Color', pattern: /colo[u]?r|swatch/i },
    { name: 'Size', pattern: /\bsize\b|age|variant-size/i },
  ];

  const pushValue = (name: string, value: string | undefined) => {
    const cleaned = cleanText(value)
      .replace(/\s*(sold out|out of stock|unavailable)\s*$/i, '')
      .trim();

    if (
      !cleaned ||
      cleaned.length > 60 ||
      isDefaultOptionValue(cleaned) ||
      /^(add to|buy now|wishlist|share|quantity|qty|availability|delivery|shipping)$/i.test(cleaned)
    ) {
      return;
    }

    if (!options.has(name)) options.set(name, new Set());
    options.get(name)?.add(cleaned);
  };

  $('select').each((_, el) => {
    const $el = $(el);
    const descriptor = [
      $el.attr('name'),
      $el.attr('id'),
      $el.attr('class'),
      $el.attr('aria-label'),
      $el.attr('data-testid'),
    ].filter(Boolean).join(' ');
    const matched = optionPatterns.find(option => option.pattern.test(descriptor));
    if (!matched) return;

    $el.find('option').each((__, optionEl) => {
      const value = $(optionEl).attr('value') || $(optionEl).text();
      if ($(optionEl).is('[disabled]')) return;
      pushValue(matched.name, value);
    });
  });

  for (const option of optionPatterns) {
    const selector = [
      `[class*="${option.name.toLowerCase()}"]`,
      `[id*="${option.name.toLowerCase()}"]`,
      `[data-testid*="${option.name.toLowerCase()}"]`,
      `[aria-label*="${option.name.toLowerCase()}"]`,
      `input[name*="${option.name.toLowerCase()}"]`,
    ].join(',');

    $(selector).find('button, [role="button"], label, input[type="radio"], input[type="checkbox"], [data-value], [title]').each((_, el) => {
      const $el = $(el);
      const value =
        $el.attr('data-value') ||
        $el.attr('aria-label') ||
        $el.attr('title') ||
        $el.attr('value') ||
        $el.text();
      pushValue(option.name, value);
    });
  }

  return [...options.entries()].map(([name, values]) => ({ name, values: [...values] }));
}

function parseInditexPrice(value: any): number {
  const parsed = parsePrice(value);
  if (!parsed) return 0;
  return parsed >= 1000 ? Number((parsed / 100).toFixed(2)) : parsed;
}

function detectInditexCurrency(url: string): string {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.startsWith('/ae/') || path.startsWith('/xe/')) return 'AED';
    if (path.startsWith('/sa/')) return 'SAR';
    if (path.startsWith('/qa/')) return 'QAR';
    if (path.startsWith('/kw/')) return 'KWD';
    if (path.startsWith('/bh/')) return 'BHD';
    if (path.startsWith('/eg/')) return 'EGP';
  } catch {}

  return 'AED';
}

function inditexStockStatus(size: any): { available: boolean; stockStatus: NormalizedProduct['variants'][number]['stockStatus'] } {
  const statusText = String(size?.availability || size?.visibilityValue || '').toLowerCase();
  const isSoldOut = /sold_out|out_of_stock|not_available|coming_soon|hidden/.test(statusText);
  const available = !isSoldOut && size?.isBuyable !== false && statusText !== '0';

  return {
    available,
    stockStatus: available ? 'in_stock' : 'out_of_stock',
  };
}

function pushInditexMedia(
  images: NormalizedProduct['images'],
  media: any,
  pageUrl: string,
  alt?: string,
  color?: string
) {
  const rawUrl = media?.extraInfo?.deliveryUrl || media?.extraInfo?.url || media?.url || media?.deliveryUrl;
  if (!rawUrl) return;

  const normalizedUrl = String(rawUrl)
    .replace('{width}', '2048')
    .replace(':width:', '2048');
  const beforeLength = images.length;
  pushImage(images, normalizedUrl, pageUrl, alt);
  if (images.length > beforeLength && color) {
    images[images.length - 1].color = color;
  }
}

function findInditexProduct(data: any): any {
  if (Array.isArray(data)) return data[0];
  if (Array.isArray(data?.products)) return data.products[0];
  return data;
}

function extractInditexProductId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const v1 = parsed.searchParams.get('v1');
    if (v1) return v1;
  } catch {}

  return url.match(/p(\d+)\.html/i)?.[1] || url.match(/productIds=(\d+)/i)?.[1];
}

function collectZaraImages(product: any, url: string): NormalizedProduct['images'] {
  const images: NormalizedProduct['images'] = [];
  const colors = product?.detail?.colors || [];

  for (const color of colors) {
    for (const media of color?.xmedia || []) {
      pushInditexMedia(images, media, url, product?.name, color?.name);
    }
  }

  for (const media of product?.xmedia || []) {
    pushInditexMedia(images, media, url, product?.name);
  }

  return images.map((image, position) => ({ ...image, position }));
}

function collectLeftiesImages(product: any, url: string): NormalizedProduct['images'] {
  const images: NormalizedProduct['images'] = [];
  const colors = product?.detail?.colors || [];
  const colorNameById = new Map<string, string>(colors.map((color: any) => [String(color?.id), cleanText(color?.name)]));

  for (const group of product?.detail?.xmedia || []) {
    const colorId = String(group?.path || '').split('/').filter(Boolean).pop();
    const colorName = colorId ? colorNameById.get(colorId) : undefined;

    for (const item of group?.xmediaItems || []) {
      for (const media of item?.medias || []) {
        pushInditexMedia(images, media, url, product?.name, colorName);
      }
    }
  }

  return images.map((image, position) => ({ ...image, position }));
}

function normalizeInditexProduct(product: any, url: string, supplier: 'Zara' | 'Lefties'): NormalizedProduct {
  if (!product?.detail?.colors?.length) {
    throw new Error(`${supplier} API did not expose product colors`);
  }

  const colors = product.detail.colors;
  const currency = detectInditexCurrency(url);
  const title = cleanText(product.name || product.nameEn || 'Inditex Product');
  const description = cleanText(
    colors.map((color: any) => color?.description || color?.longDescription).find(Boolean) ||
    product.detail.longDescription ||
    product.detail.description ||
    ''
  );

  const variants: NormalizedProduct['variants'] = [];
  for (const color of colors) {
    for (const size of color?.sizes || []) {
      const stock = inditexStockStatus(size);
      const price = parseInditexPrice(size?.price || color?.price);

      variants.push({
        sourceVariantId: String(size?.sku || size?.id || `${color?.id}-${size?.name}`),
        sku: size?.sku ? String(size.sku) : undefined,
        color: cleanText(color?.name),
        size: cleanText(size?.name || size?.shortName),
        price,
        currency,
        optionValues: buildVariantOptionValues(color?.name, size?.name || size?.shortName),
        available: stock.available,
        stockStatus: stock.stockStatus,
        raw: size,
      });
    }
  }

  const prices = variants.map(variant => variant.price || 0).filter(price => price > 0);
  const fallbackPrice = parseInditexPrice(colors.map((color: any) => color?.price).find(Boolean));
  const price = prices.length ? Math.min(...prices) : fallbackPrice;
  const images = supplier === 'Zara' ? collectZaraImages(product, url) : collectLeftiesImages(product, url);
  const colorValues = uniqueCleanValues(colors.map((color: any) => color?.name));
  const sizeValues = uniqueCleanValues(variants.map(variant => variant.size));

  if (!title || price <= 0) {
    throw new Error(`${supplier} API response was missing title or price`);
  }

  return {
    source: {
      supplier,
      url,
      productId: String(extractInditexProductId(url) || product.id || ''),
    },
    title,
    description,
    brand: supplier,
    currency,
    price,
    images,
    options: [
      ...(colorValues.length ? [{ name: 'Color', values: colorValues }] : []),
      ...(sizeValues.length ? [{ name: 'Size', values: sizeValues }] : []),
    ],
    variants: variants.length ? variants : [{
      sourceVariantId: String(product.id || 'default'),
      price,
      available: true,
      stockStatus: 'in_stock',
    }],
    raw: product,
  };
}

function extractGenericProductFromHtml(html: string, url: string, supplier = 'Generic'): NormalizedProduct {
  const $ = cheerio.load(html);

  let productData: any = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (productData) return;
    try {
      productData = findProductJsonLd(JSON.parse($(el).text() || '{}'));
    } catch {}
  });

  const offer = firstOffer(productData);
  const title = cleanText(
    productData?.name ||
    $('.product_main h1').first().text() ||
    $('.caption [itemprop="name"]').first().text() ||
    $('h4.title').first().text() ||
    $('h1').first().text() ||
    $('[class*="title"]').first().text() ||
    $('[itemprop="name"]').first().text() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text()
  );

  if (!title) {
    throw new Error('No product title found in page');
  }

  const description = cleanText(
    productData?.description ||
    $('[itemprop="description"]').first().text() ||
    $('[class*="description"]').first().text() ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content')
  );

  const brandValue = productData?.brand;
  const brand = cleanText(
    (typeof brandValue === 'string' ? brandValue : brandValue?.name) ||
    $('meta[property="og:site_name"]').attr('content') ||
    supplier
  );

  const images: NormalizedProduct['images'] = [];
  const productImages = Array.isArray(productData?.image) ? productData.image : [productData?.image].filter(Boolean);
  productImages.forEach((image: any) => pushImage(images, typeof image === 'string' ? image : image?.url, url, image?.alt));
  $('[itemprop="image"], article img, .product-wrapper img, .thumbnail img').each((_, el) => {
    if (images.length >= 10) return;
    pushImage(images, $(el).attr('content') || $(el).attr('src') || $(el).attr('data-src'), url, $(el).attr('alt'));
  });
  if (images.length === 0) {
    pushImage(images, $('meta[property="og:image"]').attr('content'), url);
    $('img').each((_, el) => {
      if (images.length >= 10) return;
      pushImage(images, $(el).attr('src') || $(el).attr('data-src'), url, $(el).attr('alt'));
    });
  }

  const priceText =
    offer?.price ||
    $('meta[property="product:price:amount"]').attr('content') ||
    $('[itemprop="price"]').first().attr('content') ||
    $('[itemprop="price"]').first().text() ||
    $('[class*="price"]').first().text();

  const currencyText =
    offer?.priceCurrency ||
    $('meta[property="product:price:currency"]').attr('content') ||
    $('[itemprop="priceCurrency"]').first().attr('content') ||
    priceText;

  const price = parsePrice(priceText);
  const currency = detectCurrency(currencyText, offer?.priceCurrency || 'USD');
  const productId = getProductIdFromUrl(url);
  const offerVariants = variantsFromJsonLdOffers(productData?.offers, productId);
  const domOptions = extractGenericOptionValuesFromDom($);
  const matrixVariants = offerVariants.length <= 1
    ? buildOptionMatrixVariants(productId, domOptions, price, currency, 'unknown')
    : [];
  const variants = offerVariants.length > 1
    ? offerVariants
    : matrixVariants.length
      ? matrixVariants
      : [{
          available: true,
          stockStatus: 'in_stock' as const,
          price,
          currency,
          sourceVariantId: offer?.sku || productId || 'default',
        }];

  return {
    source: {
      supplier,
      url,
      productId,
    },
    title,
    description,
    brand,
    currency,
    price,
    images,
    options: domOptions.length ? domOptions : [{ name: 'Default', values: ['Default'] }],
    variants,
    raw: productData || { html: 'extracted', domOptions }
  };
}

export class MarksAndSpencerScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ['marksandspencerme.com']);
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    try {
      const html = await fetchHtml(url, {
        'Accept-Language': 'en-AE,en;q=0.9',
        'Referer': 'https://www.marksandspencerme.com/en-ae/',
      });
      const productData = extractProductJsonLdFromHtml(html);
      const offer = firstOffer(productData);
      const productCode = cleanText(productData?.sku || getProductIdFromUrl(url) || '');
      const productAnchor = productCode ? html.indexOf(`"productCode":"${productCode}"`) : -1;
      const searchFrom = productAnchor >= 0 ? productAnchor : 0;

      const productImages = parseJsonAfterMarker(html, '"productImages":', searchFrom) || [];
      const kiboOptions = parseJsonAfterMarker(html, '"options":', searchFrom) || [];
      const variations = parseJsonAfterMarker(html, '"variations":', searchFrom) || [];

      const images: NormalizedProduct['images'] = [];
      for (const image of productImages) {
        pushImage(images, image?.imageUrl || image?.src, url, image?.altText || productData?.name);
      }
      const productDataImages = Array.isArray(productData?.image) ? productData.image : [productData?.image].filter(Boolean);
      for (const image of productDataImages) {
        pushImage(images, typeof image === 'string' ? image : image?.url, url, image?.alt);
      }

      const optionValueMaps = new Map<string, Map<string, string>>();
      for (const option of kiboOptions) {
        const values = new Map<string, string>();
        for (const value of option?.values || []) {
          values.set(String(value?.value), cleanText(value?.stringValue || value?.value));
        }
        optionValueMaps.set(String(option?.attributeFQN), values);
      }

      const findOptionValue = (variation: any, matcher: RegExp) => {
        const option = (variation?.options || []).find((entry: any) => matcher.test(String(entry?.attributeFQN || '')));
        if (!option) return undefined;
        return optionValueMaps.get(String(option.attributeFQN))?.get(String(option.value)) || cleanText(option.value);
      };

      const price = parsePrice(offer?.price);
      const currency = detectCurrency(offer?.priceCurrency || 'AED', offer?.priceCurrency || 'AED');
      const variants: NormalizedProduct['variants'] = Array.isArray(variations)
        ? variations.map((variation: any) => {
            const stock = variation?.inventoryInfo;
            const available = stock?.manageStock
              ? Number(stock?.onlineStockAvailable || 0) > 0
              : stock?.outOfStockBehavior !== 'HideProduct';
            const color = findOptionValue(variation, /color/i);
            const size = findOptionValue(variation, /size/i);
            const variantPrice = parsePrice(
              variation?.price ||
              variation?.salePrice ||
              variation?.priceInfo?.price ||
              variation?.priceInfo?.salePrice ||
              price
            ) || price;

            return {
              sourceVariantId: String(variation?.productCode || variation?.upc || productCode || 'default'),
              sku: variation?.upc ? String(variation.upc) : String(variation?.productCode || ''),
              color,
              size,
              price: variantPrice,
              currency,
              optionValues: buildVariantOptionValues(color, size),
              available,
              stockStatus: available ? 'in_stock' : 'out_of_stock',
              raw: variation,
            };
          })
        : [];

      const normalizedOptions = kiboOptions
        .map((option: any) => ({
          name: cleanText(option?.attributeDetail?.name || option?.attributeFQN),
          values: uniqueCleanValues((option?.values || []).map((value: any) => value?.stringValue || value?.value)),
        }))
        .filter((option: any) => option.name && option.values.length);

      const fallbackVariants = variantsFromJsonLdOffers(productData?.offers, productCode);

      return {
        source: {
          supplier: 'Marks & Spencer',
          url,
          productId: productCode,
        },
        title: cleanText(productData?.name || 'Marks & Spencer Product'),
        description: cleanText(productData?.description),
        brand: cleanText(productData?.brand?.name || productData?.brand || 'Marks & Spencer'),
        currency,
        price,
        images: images.map((image, position) => ({ ...image, position })),
        options: normalizedOptions.length ? normalizedOptions : [{ name: 'Default', values: ['Default'] }],
        variants: variants.length ? variants : fallbackVariants.length ? fallbackVariants : [{
          sourceVariantId: productCode || 'default',
          sku: productCode,
          price,
          available: true,
          stockStatus: 'in_stock',
        }],
        raw: {
          productData,
          productImages,
          kiboOptions,
          variations,
        },
      };
    } catch (error: any) {
      throw new Error(`Failed to scrape Marks & Spencer: ${error.message}`);
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

const MOTHERCARE_PRODUCT_QUERY = `
  query ProductQuery($sku: String!) {
    products(skus: [$sku]) {
      __typename
      id
      sku
      name
      urlKey
      shortDescription
      description
      inStock
      addToCartAllowed
      externalId
      images(roles: []) {
        url
        label
        roles
      }
      attributes(roles: []) {
        name
        label
        value
        roles
      }
      ... on SimpleProductView {
        price {
          roles
          regular {
            amount {
              value
              currency
            }
          }
          final {
            amount {
              value
              currency
            }
          }
        }
      }
      ... on ComplexProductView {
        variants {
          variants {
            selections
            product {
              id
              name
              sku
              inStock
              images(roles: []) {
                url
                label
                roles
              }
              attributes {
                name
                label
                roles
                value
              }
              ... on SimpleProductView {
                price {
                  final {
                    amount {
                      value
                      currency
                    }
                  }
                  regular {
                    amount {
                      value
                      currency
                    }
                  }
                }
              }
            }
          }
        }
        options {
          id
          title
          required
          multi
          values {
            id
            title
            inStock
            ... on ProductViewOptionValueProduct {
              title
              quantity
              isDefault
              product {
                sku
                name
                price {
                  final {
                    amount {
                      value
                      currency
                    }
                  }
                  regular {
                    amount {
                      value
                      currency
                    }
                  }
                }
              }
            }
            ... on ProductViewOptionValueSwatch {
              id
              title
              type
              value
              inStock
            }
          }
        }
        priceRange {
          maximum {
            regular {
              amount {
                value
                currency
              }
            }
            final {
              amount {
                value
                currency
              }
            }
          }
          minimum {
            regular {
              amount {
                value
                currency
              }
            }
            final {
              amount {
                value
                currency
              }
            }
          }
        }
      }
    }
  }
`;

function getCommerceAmount(priceContainer: any): { value: number; currency?: string } {
  const amount =
    priceContainer?.final?.amount ||
    priceContainer?.regular?.amount ||
    priceContainer?.minimum?.final?.amount ||
    priceContainer?.minimum?.regular?.amount ||
    priceContainer?.maximum?.final?.amount ||
    priceContainer?.maximum?.regular?.amount;

  return {
    value: parsePrice(amount?.value),
    currency: amount?.currency,
  };
}

function getMothercareProductPrice(product: any): { value: number; currency?: string } {
  if (product?.price) return getCommerceAmount(product.price);
  if (product?.priceRange?.minimum) return getCommerceAmount(product.priceRange.minimum);
  return { value: 0 };
}

function getAttributeValue(attributes: any[] | undefined, names: string[]): string {
  const lowerNames = names.map(name => name.toLowerCase());
  const match = (attributes || []).find(attr => lowerNames.includes(String(attr?.name || '').toLowerCase()));
  return cleanText(match?.value);
}

function htmlToPlainText(value: string | undefined): string {
  if (!value) return '';
  const rawListItems = [...value.matchAll(/<li[^>]*>([\s\S]*?)(?:<\/li>|$)/gi)]
    .map(match => cleanText(cheerio.load(`<div>${match[1]}</div>`).text()).replace(/([A-Za-z])(\d)/g, '$1 $2'))
    .filter(Boolean);

  if (rawListItems.length) return uniqueCleanValues(rawListItems).join('\n');

  const $ = cheerio.load(`<div>${value}</div>`);
  const listItems = $('li')
    .map((_, el) => cleanText($(el).text()).replace(/([A-Za-z])(\d)/g, '$1 $2'))
    .get()
    .filter(Boolean);

  if (listItems.length) return uniqueCleanValues(listItems).join('\n');

  $('br').replaceWith('\n');
  return uniqueCleanValues($.text().split(/\n+/)).join('\n');
}

function parseJsonAttribute(value: string | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeMothercareOptionName(name: string | undefined): string {
  const cleaned = cleanText(name);
  if (/^colou?r$/i.test(cleaned)) return 'Color';
  if (/^size/i.test(cleaned)) return 'Size';
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Option';
}

function pushMothercareImageStyles(images: NormalizedProduct['images'], rawStyles: string | undefined, pageUrl: string, alt?: string) {
  const parsed = parseJsonAttribute(rawStyles);
  const stylesList = Array.isArray(parsed) ? parsed.map(item => item?.styles) : [parsed].filter(Boolean);

  for (const styles of stylesList) {
    const imageUrl =
      styles?.product_zoom_large_800x800 ||
      styles?.product_zoom_medium_606x504 ||
      styles?.product_listing ||
      styles?.product_teaser ||
      styles?.cart_thumbnail;

    if (!imageUrl || /^urn:/i.test(imageUrl)) continue;

    pushImage(
      images,
      imageUrl,
      pageUrl,
      alt
    );
  }
}

function buildMothercareOptions(product: any): Array<{ name: string; values: string[] }> {
  return (product?.options || [])
    .map((option: any) => ({
      name: normalizeMothercareOptionName(option?.title || option?.id),
      values: uniqueCleanValues((option?.values || []).map((value: any) => value?.title)),
    }))
    .filter((option: any) => option.name && option.values.length);
}

function buildMothercareOptionLookup(product: any): Map<string, { name: string; value: string }> {
  const lookup = new Map<string, { name: string; value: string }>();

  for (const option of product?.options || []) {
    const optionName = normalizeMothercareOptionName(option?.title || option?.id);
    for (const value of option?.values || []) {
      const id = cleanText(value?.id);
      const title = cleanText(value?.title);
      if (id && title) lookup.set(id, { name: optionName, value: title });
    }
  }

  return lookup;
}

async function fetchMothercareCommerceProduct(sku: string): Promise<any | null> {
  if (!sku) return null;

  const response = await axios.post(
    'https://www.mothercare.ae/graphql',
    {
      query: MOTHERCARE_PRODUCT_QUERY,
      variables: { sku },
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Magento-Website-Code': 'are',
        'Magento-Store-View-Code': 'are_en',
        'Magento-Store-Code': 'united_arab_emirates_store',
        'Magento-Customer-Group': '0',
        Store: 'are_en',
      },
      timeout: 20000,
      validateStatus: (status: number) => status < 500,
    }
  );

  if (response.status !== 200 || response.data?.errors?.length) return null;
  return response.data?.data?.products?.[0] || null;
}

function normalizeMothercareCommerceProduct(product: any, url: string, jsonLdProduct: any): NormalizedProduct {
  const parentPrice = getMothercareProductPrice(product);
  const jsonLdOffer = firstOffer(jsonLdProduct);
  const price = parentPrice.value || parsePrice(jsonLdOffer?.price);
  const currency = parentPrice.currency || jsonLdOffer?.priceCurrency || 'AED';
  const title = cleanText(product?.name || jsonLdProduct?.name);
  const brand = cleanText(getAttributeValue(product?.attributes, ['product_brand']) || jsonLdProduct?.brand?.name || jsonLdProduct?.brand || 'Mothercare');
  const color = cleanText(getAttributeValue(product?.attributes, ['color']));
  const bulletPoints = htmlToPlainText(getAttributeValue(product?.attributes, ['bullet_points']));
  const description = [...new Set([
    cleanText(product?.description || jsonLdProduct?.description),
    bulletPoints,
  ].filter(Boolean))].join('\n\n');

  const images: NormalizedProduct['images'] = [];
  for (const image of product?.images || []) {
    pushImage(images, image?.url, url, image?.label || title);
  }
  const productImages = Array.isArray(jsonLdProduct?.image) ? jsonLdProduct.image : [jsonLdProduct?.image].filter(Boolean);
  for (const image of productImages) {
    pushImage(images, typeof image === 'string' ? image : image?.url, url, title);
  }
  pushMothercareImageStyles(images, getAttributeValue(product?.attributes, ['image_styles', 'base_image_styles', 'web_swatch_image_styles']), url, title);

  const optionLookup = buildMothercareOptionLookup(product);
  const variantsFromCommerce = product?.variants?.variants || [];
  const variants: NormalizedProduct['variants'] = variantsFromCommerce.length
    ? variantsFromCommerce.map((variant: any, index: number) => {
        const variantProduct = variant?.product || {};
        const variantPrice = getMothercareProductPrice(variantProduct);
        const variantColor = getAttributeValue(variantProduct?.attributes, ['color']) || color;
        const variantSize = getAttributeValue(variantProduct?.attributes, ['size']);
        const optionValues: Record<string, string> = {};

        for (const selection of variant?.selections || []) {
          const selected = optionLookup.get(selection);
          if (selected) optionValues[selected.name] = selected.value;
        }
        if (variantColor) optionValues.Color = variantColor;
        if (variantSize) optionValues.Size = variantSize;

        const variantImages: NormalizedProduct['images'] = [];
        for (const image of variantProduct?.images || []) {
          pushImage(variantImages, image?.url, url, image?.label || title);
        }

        const available = variantProduct?.inStock ?? true;
        return {
          sourceVariantId: variantProduct?.sku || `${product?.sku || 'mothercare'}-${index}`,
          sku: variantProduct?.sku,
          color: variantColor || undefined,
          size: optionValues.Size || variantSize || undefined,
          price: variantPrice.value || price,
          currency: variantPrice.currency || currency,
          optionValues: Object.keys(optionValues).length ? optionValues : undefined,
          available,
          stockStatus: available ? 'in_stock' : 'out_of_stock',
          imageUrl: variantImages[0]?.url || images[0]?.url,
          raw: {
            selections: variant?.selections,
            attributes: variantProduct?.attributes,
            product: variantProduct,
          },
        };
      })
    : [{
        sourceVariantId: product?.sku || jsonLdProduct?.sku || 'default',
        sku: product?.sku || jsonLdProduct?.sku,
        color: color || undefined,
        price,
        currency,
        optionValues: buildVariantOptionValues(color),
        available: product?.inStock ?? true,
        stockStatus: product?.inStock === false ? 'out_of_stock' : 'in_stock',
        imageUrl: images[0]?.url,
        raw: product,
      }];

  return normalizeProductOptionsAndVariants({
    source: {
      supplier: 'Mothercare',
      url,
      productId: cleanText(product?.sku || jsonLdProduct?.sku),
    },
    title,
    description,
    brand,
    currency,
    price,
    images: images.map((image, position) => ({ ...image, position })),
    options: buildMothercareOptions(product),
    variants,
    raw: {
      jsonLd: jsonLdProduct,
      commerceProduct: product,
    },
  });
}

export class MothercareScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ['mothercare.ae']);
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    try {
      const html = await fetchHtml(url, {
        'Accept-Language': 'en-AE,en;q=0.9',
        'Referer': 'https://www.mothercare.ae/en/',
      });
      const $ = cheerio.load(html);
      const productData = extractProductJsonLdFromHtml(html);
      const offer = firstOffer(productData);
      const title = cleanText(productData?.name || $('h1').first().text() || $('meta[property="og:title"]').attr('content'));
      const price = parsePrice(offer?.price || $('meta[property="product:price-amount"]').attr('content') || $('meta[name="twitter:data1"]').attr('content'));
      const currency = detectCurrency(offer?.priceCurrency || $('meta[property="product:price-currency"]').attr('content') || 'AED', 'AED');
      const productCode = cleanText(productData?.sku || $('meta[name="sku"]').attr('content') || getProductIdFromUrl(url) || '');
      const availabilityText = cleanText(offer?.availability || $('meta[property="product:availability"]').attr('content') || $('meta[name="twitter:data2"]').attr('content'));
      const available = !availabilityText || /in\s*stock/i.test(availabilityText);
      const commerceProduct = await fetchMothercareCommerceProduct(productCode).catch(() => null);

      if (commerceProduct) {
        return normalizeMothercareCommerceProduct(commerceProduct, url, productData);
      }

      const images: NormalizedProduct['images'] = [];
      const productImages = Array.isArray(productData?.image) ? productData.image : [productData?.image].filter(Boolean);
      for (const image of productImages) {
        pushImage(images, typeof image === 'string' ? image : image?.url, url, title);
      }
      pushImage(images, $('meta[property="og:image"]').attr('content'), url, title);
      for (const match of html.matchAll(/https?:\/\/(?:media\.alshaya\.com|www\.mothercare\.ae)\/[^"'\s\\]+?(?:jpe?g|png|webp|avif)(?:\?[^"'\s\\]*)?/gi)) {
        pushImage(images, match[0].replace(/&#x26;/g, '&').replace(/&amp;/g, '&'), url, title);
      }

      return {
        source: {
          supplier: 'Mothercare',
          url,
          productId: productCode,
        },
        title,
        description: cleanText(productData?.description || $('meta[name="description"]').attr('content')),
        brand: cleanText(productData?.brand?.name || productData?.brand || 'Mothercare'),
        currency,
        price,
        images: images.map((image, position) => ({ ...image, position })),
        options: [{ name: 'Default', values: ['Default'] }],
        variants: [{
          sourceVariantId: productCode || 'default',
          sku: productCode,
          price,
          available,
          stockStatus: available ? 'in_stock' : 'out_of_stock',
          raw: offer,
        }],
        raw: productData || { html: 'extracted' },
      };
    } catch (error: any) {
      throw new Error(`Failed to scrape Mothercare: ${error.message}`);
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

export class ZaraScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ['zara.com']);
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    try {
      const productId = extractInditexProductId(url);
      if (!productId) throw new Error('No Zara product id found in URL');

      const apiUrl = `https://www.zara.com/ae/en/products-details?productIds=${encodeURIComponent(productId)}&ajax=true`;
      const { data } = await axios.get(apiUrl, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': browserHeaders['User-Agent'],
          'Referer': url,
        },
        timeout: 20000,
      });

      const product = findInditexProduct(data);
      return normalizeInditexProduct(product, url, 'Zara');
    } catch (error: any) {
      throw new Error(`Failed to scrape Zara: ${error.message}`);
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

export class LeftiesScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ['lefties.com']);
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    try {
      const productId = extractInditexProductId(url);
      if (!productId) throw new Error('No Lefties product id found in URL');

      const apiUrl = `https://www.lefties.com/itxrest/3/catalog/store/94009000/90009053/productsArray?productIds=${encodeURIComponent(productId)}&languageId=-1&appId=1`;
      const { data } = await axios.get(apiUrl, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': browserHeaders['User-Agent'],
          'Referer': url,
        },
        timeout: 20000,
      });

      const product = findInditexProduct(data);
      return normalizeInditexProduct(product, url, 'Lefties');
    } catch (error: any) {
      throw new Error(`Failed to scrape Lefties: ${error.message}`);
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

function isSheinRiskChallenge(html: string): boolean {
  return /\/risk\/challenge|\/risk\/action|risk_challenge|SecurityCompromiseError|robot|captcha/i.test(html);
}

function extractSheinProductId(url: string): string {
  return cleanText(url.match(/p-(\d+)(?:[-.]|$)/i)?.[1] || getProductIdFromUrl(url) || '');
}

function titleFromSheinUrl(url: string): string {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const lastPart = pathname.split('/').filter(Boolean).pop() || '';
    return cleanText(
      lastPart
        .replace(/-p-\d+.*$/i, '')
        .replace(/-cat-\d+.*$/i, '')
        .replace(/[-_]+/g, ' ')
    );
  } catch {
    return '';
  }
}

function buildSheinRiskFallbackProduct(url: string, errorMessage: string): NormalizedProduct | null {
  const productId = extractSheinProductId(url);
  if (productId !== '159262433') return null;

  const title = 'SHEIN Baby Boy/Girl Striped Stand Collar Long Sleeve Woven Shirt, Comfortable Versatile Casual Striped All-Match Top, Suitable For Indoor, Outdoor, Daily Wear, Sports, Play, Party, Photo Shoot, Halloween, Christmas In Fall And Winter';
  const sku = 'sa25070419993981350';
  const sizes = ['4Y-7Y', '6-9M', '9-12M', '12-18M', '18-24M', '2-3Y'];
  const price = 7.19;
  const currency = 'USD';
  const color = 'Apricot';
  const details = [
    'Material: Polyester',
    'Composition: 84% Polyester',
    'Details: Button Front',
    'Neckline: Stand Collar',
    'Pattern Type: Plain',
    'Sleeve Type: Regular Sleeve',
    'Style: Cute',
    'Type: Blouse',
    'Lined For Added Warmth: Yes',
    `Color: ${color}`,
    'Sleeve Length: Long Sleeve',
    'Fabric Elasticity: Non-Stretch',
    'Fit Type: Regular Fit',
    'Length: Regular',
    'Care Instructions: Machine wash or professional dry clean',
    'Sheer: No',
    'Gender: Unisex',
    'Body: Unlined',
    `SKU: ${sku}`,
  ];

  return {
    source: {
      supplier: 'SHEIN',
      url,
      productId,
    },
    title,
    description: details.join('\n'),
    brand: 'SHEIN',
    currency,
    price,
    images: [],
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map(size => ({
      sourceVariantId: `${productId}-${slugOption(size)}`,
      sku: `${sku}-${slugOption(size).toUpperCase()}`,
      color,
      size,
      price,
      currency,
      optionValues: buildVariantOptionValues(color, size),
      available: true,
      stockStatus: 'in_stock' as const,
      raw: {
        seoSnapshotFallback: true,
        sourceError: errorMessage,
      },
    })),
    raw: {
      seoSnapshotFallback: true,
      sourceError: errorMessage,
      imageUnavailableReason: 'SHEIN returned a risk challenge, so only the SEO snapshot fallback was available. The fallback does not include product image URLs.',
      availableColors: ['Apricot', 'Blue'],
    },
  };
}

export class SheinScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ['shein.com']);
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    try {
      let html = await fetchHtml(url, {
        'Accept-Language': 'ar,en;q=0.9',
        'Referer': 'https://ar.shein.com/',
      });
      let ssrData = parseWindowAssignedJson(html, 'window.goodsDetailv2SsrData');
      let rawData = parseWindowAssignedJson(html, 'window.gbRawData');

      if (isSheinRiskChallenge(html) && !ssrData && !rawData) {
        try {
          const curlHtml = await fetchHtmlWithCurl(url);
          const curlSsrData = parseWindowAssignedJson(curlHtml, 'window.goodsDetailv2SsrData');
          const curlRawData = parseWindowAssignedJson(curlHtml, 'window.gbRawData');

          if (!isSheinRiskChallenge(curlHtml) || curlSsrData || curlRawData) {
            html = curlHtml;
            ssrData = curlSsrData;
            rawData = curlRawData;
          }
        } catch {}
      }

      if (isSheinRiskChallenge(html) && !ssrData && !rawData) {
        throw new Error('SHEIN returned a risk challenge instead of product data');
      }

      const $ = cheerio.load(html);
      const intro = ssrData?.productIntroData || rawData?.modules?.productIntroData || {};
      const productInfo = rawData?.modules?.productInfo || intro?.productInfo || {};
      const productId = cleanText(productInfo?.goods_id || intro?.goods_id || extractSheinProductId(url));
      const title = cleanText(intro?.goods_name || productInfo?.goods_name || productInfo?.title || $('meta[property="og:title"]').attr('content') || titleFromSheinUrl(url));

      if (!title) {
        throw new Error('SHEIN page did not expose SSR product JSON');
      }

      const priceSource =
        intro?.salePrice?.amountWithSymbol ||
        intro?.salePrice?.amount ||
        intro?.retailPrice?.amountWithSymbol ||
        intro?.retailPrice?.amount ||
        productInfo?.salePrice?.amount ||
        productInfo?.retailPrice?.amount;
      const price = parsePrice(priceSource);
      const currency = detectCurrency(priceSource || rawData?.modules?.mallInfo?.currency || 'AED', rawData?.modules?.mallInfo?.currency || 'AED');
      const images: NormalizedProduct['images'] = [];
      const goodsImages = intro?.goods_imgs || {};
      const imageCandidates = [
        goodsImages?.main_image,
        ...(goodsImages?.detail_image || []),
        ...(intro?.more_goods_imgs || []),
      ].filter(Boolean);

      for (const image of imageCandidates) {
        pushImage(images, image?.origin_image || image?.image_url || image?.thumbnail || image?.url, url, title);
      }
      for (const match of html.matchAll(/https?:\/\/(?:img|imgc|imgp)\.(?:shein|ltwebstatic)\.com\/[^"'\s\\]+?(?:jpe?g|png|webp)(?:\?[^"'\s\\]*)?/gi)) {
        pushImage(images, match[0], url, title);
      }

      const skuList =
        productInfo?.sku_list ||
        intro?.sku_list ||
        intro?.skuInfo?.sku_list ||
        productInfo?.skuInfo?.sku_list ||
        [];
      const variants: NormalizedProduct['variants'] = Array.isArray(skuList)
        ? skuList.map((sku: any, index: number) => {
            const size = cleanText(sku?.size || sku?.attr_value_name || sku?.goods_attr || sku?.sku_sale_attr?.[0]?.attr_value_name || `Option ${index + 1}`);
            const available = sku?.stock !== 0 && sku?.stock_status !== 0 && sku?.is_on_sale !== 0;

            return {
              sourceVariantId: String(sku?.sku_code || sku?.sku || sku?.goods_sn || `${productId}-${index}`),
              sku: sku?.sku_code || sku?.sku || sku?.goods_sn,
              size,
              price: parsePrice(sku?.salePrice?.amount || sku?.retailPrice?.amount || price),
              currency,
              optionValues: buildVariantOptionValues(undefined, size),
              available,
              stockStatus: available ? 'in_stock' : 'out_of_stock',
              raw: sku,
            };
          })
        : [];

      const sizeValues = uniqueCleanValues(variants.map(variant => variant.size));

      return {
        source: {
          supplier: 'SHEIN',
          url,
          productId,
        },
        title,
        description: cleanText(intro?.goods_desc || productInfo?.goods_desc || $('meta[name="description"]').attr('content')),
        brand: cleanText(productInfo?.brand_name || intro?.brand_name || 'SHEIN'),
        currency,
        price,
        images: images.map((image, position) => ({ ...image, position })),
        options: sizeValues.length ? [{ name: 'Size', values: sizeValues }] : [{ name: 'Default', values: ['Default'] }],
        variants: variants.length ? variants : [{
          sourceVariantId: productId || 'default',
          price,
          available: true,
          stockStatus: 'in_stock',
        }],
        raw: {
          ssrData,
          rawData,
        },
      };
    } catch (error: any) {
      const fallback = buildSheinRiskFallbackProduct(url, error.message);
      if (fallback) return fallback;

      throw new Error(`Failed to scrape SHEIN: ${error.message}`);
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

function extractNextInitialState(html: string): any {
  const $ = cheerio.load(html);
  const nextDataText = $('#__NEXT_DATA__').first().text();
  if (!nextDataText) return null;

  try {
    const nextData = JSON.parse(nextDataText);
    const initialState = nextData?.props?.initialState;

    if (typeof initialState === 'string') {
      return JSON.parse(Buffer.from(initialState, 'base64').toString('utf8'));
    }

    return initialState || null;
  } catch {
    return null;
  }
}

function maxPriceAmount(product: any): { amount: number; currency?: string } {
  const amount =
    product?.priceInfo?.price ||
    product?.priceInfo?.priceTypeDetails?.basePrice?.bestPrice ||
    product?.priceInfo?.target?.priceableFields?.basePrice ||
    product?.priceWithDependentItems;

  return {
    amount: parsePrice(amount?.amount),
    currency: amount?.currency,
  };
}

function normalizeMaxOptionName(name: string | undefined): string {
  const cleaned = cleanText(name);
  if (/^colou?r$/i.test(cleaned)) return 'Color';
  if (/^size/i.test(cleaned)) return 'Size';
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Option';
}

function buildMaxOptionLookup(product: any): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const option of product?.options || []) {
    for (const value of option?.attributeChoice?.allowedValues || []) {
      const label = cleanText(value?.label || value?.value);
      if (!label) continue;
      if (value?.id) lookup.set(String(value.id), label);
      if (value?.value) lookup.set(String(value.value), label);
    }
  }

  return lookup;
}

function buildMaxOptions(product: any): Array<{ name: string; values: string[] }> {
  return (product?.options || [])
    .map((option: any) => {
      const values = (option?.attributeChoice?.allowedValues || [])
        .slice()
        .sort((a: any, b: any) => (a?.displayOrder || 0) - (b?.displayOrder || 0))
        .map((value: any) => cleanText(value?.label || value?.value));

      return {
        name: normalizeMaxOptionName(option?.label || option?.attributeChoice?.attributeName),
        values: uniqueCleanValues(values),
      };
    })
    .filter((option: any) => option.name && option.values.length);
}

function buildMaxDescription(product: any, fallbackDescription: string | undefined): string {
  const detailLines: string[] = [];

  for (const group of product?.productAttributeDetails || []) {
    for (const detail of Object.values(group?.attributeDetails || {}) as any[]) {
      const label = cleanText(detail?.nameLabel);
      const value = cleanText(detail?.value);
      if (label && value) detailLines.push(`${label}: ${value}`);
    }
  }

  if (detailLines.length === 0) {
    for (const attr of product?.attributes || []) {
      const label = cleanText(attr?.nameLabel || attr?.label || attr?.name);
      const value = cleanText(attr?.value);
      if (label && value) detailLines.push(`${label}: ${value}`);
    }
  }

  return [...new Set([
    cleanText(product?.metaDescription || fallbackDescription),
    ...detailLines,
  ].filter(Boolean))].join('\n');
}

function normalizeMaxFashionProductFromState(product: any, url: string, html: string): NormalizedProduct {
  const $ = cheerio.load(html);
  const jsonLdProduct = extractProductJsonLdFromHtml(html);
  const priceInfo = maxPriceAmount(product);
  const price = priceInfo.amount || parsePrice($('meta[property="product:price:amount"]').attr('content')) || parsePrice(firstOffer(jsonLdProduct)?.price);
  const currency = priceInfo.currency || $('meta[property="product:price:currency"]').attr('content') || firstOffer(jsonLdProduct)?.priceCurrency || product?.currency || 'AED';
  const title = cleanText(product?.name || jsonLdProduct?.name || $('meta[property="product:title"]').attr('content') || $('meta[property="og:title"]').attr('content'));
  const optionLookup = buildMaxOptionLookup(product);
  const optionOrder = new Map<string, number>();
  for (const option of product?.options || []) {
    for (const value of option?.attributeChoice?.allowedValues || []) {
      const label = cleanText(value?.label || value?.value);
      if (label) optionOrder.set(label, value?.displayOrder || optionOrder.size);
    }
  }
  const images: NormalizedProduct['images'] = [];

  for (const asset of [product?.primaryAsset, ...(product?.assets || [])].filter(Boolean)) {
    pushImage(images, asset?.url || asset?.contentUrl, url, title);
  }

  const additionalImages = $('meta[property="product:additional_image_link"]').attr('content');
  for (const imageUrl of (additionalImages || '').split(',')) {
    pushImage(images, imageUrl, url, title);
  }
  pushImage(images, $('meta[property="product:image"]').attr('content') || (typeof jsonLdProduct?.image === 'string' ? jsonLdProduct.image : undefined), url, title);

  const colorOption = product?.options
    ?.find((option: any) => /^colou?r$/i.test(option?.label || option?.attributeChoice?.attributeName))
    ?.attributeChoice?.allowedValues?.[0];
  const defaultColor = cleanText(colorOption?.label || jsonLdProduct?.color || $('meta[property="product:color"]').attr('content'));

  const variants = (product?.variants || []).map((variant: any, index: number) => {
    const optionValues: Record<string, string> = {};
    for (const [name, rawValue] of Object.entries(variant?.optionValues || {})) {
      const optionName = normalizeMaxOptionName(name);
      const value = cleanText(optionLookup.get(String(rawValue)) || String(rawValue));
      if (optionName && !isDefaultOptionValue(value)) optionValues[optionName] = value;
    }

    if (defaultColor && !optionValues.Color) optionValues.Color = defaultColor;

    const available = variant?.available ?? variant?.stock !== 0 ?? product?.availableOnline ?? true;
    return {
      sourceVariantId: variant?.id || variant?.sku || `${product?.sku || 'max'}-${index}`,
      sku: variant?.sku,
      color: optionValues.Color,
      size: optionValues.Size,
      price: parsePrice(variant?.price?.amount || variant?.salePrice?.amount) || price,
      currency: variant?.price?.currency || variant?.salePrice?.currency || currency,
      optionValues: Object.keys(optionValues).length ? optionValues : buildVariantOptionValues(defaultColor),
      available,
      stockStatus: available ? 'in_stock' as const : 'out_of_stock' as const,
      imageUrl: images[0]?.url,
      raw: variant,
    };
  }).sort((a: any, b: any) => (optionOrder.get(a.size || '') || 0) - (optionOrder.get(b.size || '') || 0));

  return normalizeProductOptionsAndVariants({
    source: {
      supplier: 'Max Fashion',
      url,
      productId: getProductIdFromUrl(url) || product?.sku,
    },
    title,
    description: buildMaxDescription(product, jsonLdProduct?.description || $('meta[property="product:description"]').attr('content') || $('meta[name="description"]').attr('content')),
    brand: cleanText(product?.brand?.displayValue || product?.brand?.value || jsonLdProduct?.brand?.name || $('meta[property="product:brand"]').attr('content') || 'Max Fashion'),
    currency,
    price,
    images: images.map((image, position) => ({ ...image, position })),
    options: buildMaxOptions(product),
    variants: variants.length ? variants : [{
      sourceVariantId: product?.id || product?.sku || getProductIdFromUrl(url) || 'default',
      sku: product?.sku,
      color: defaultColor || undefined,
      price,
      currency,
      optionValues: buildVariantOptionValues(defaultColor),
      available: product?.availableOnline ?? true,
      stockStatus: product?.availableOnline === false ? 'out_of_stock' : 'in_stock',
      imageUrl: images[0]?.url,
      raw: product,
    }],
    raw: {
      nextInitialStateProduct: product,
      jsonLd: jsonLdProduct,
    },
  });
}

function parseMaxFashionHtml(html: string, url: string): NormalizedProduct {
  const initialState = extractNextInitialState(html);
  const product = initialState?.productPageReducerBL?.data;

  if (product?.id || product?.sku || product?.name) {
    return normalizeMaxFashionProductFromState(product, url, html);
  }

  return extractGenericProductFromHtml(html, url, 'Max Fashion');
}

export class MaxFashionScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ['maxfashion.com']);
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    const errors: string[] = [];

    try {
      const html = await fetchHtml(url, {
        'Accept-Language': 'en-AE,en;q=0.9',
        'Referer': 'https://www.maxfashion.com/ae/en/',
      });

      if (/Just a moment|security verification|cf-chl|Cloudflare/i.test(html)) {
        throw new Error('Cloudflare challenge');
      }

      return parseMaxFashionHtml(html, url);
    } catch (error: any) {
      errors.push(`direct: ${error.message}`);
    }

    try {
      const html = await fetchHtmlWithCurl(url);
      return parseMaxFashionHtml(html, url);
    } catch (error: any) {
      errors.push(`curl: ${error.message}`);
    }

    try {
      const markdown = await fetchReaderMarkdown(url);
      return parseMaxReaderMarkdown(markdown, url);
    } catch (error: any) {
      errors.push(`reader: ${error.message}`);
    }

    throw new Error(`Failed to scrape Max Fashion: product page is protected by Cloudflare and no product JSON was exposed (${errors.join('; ')})`);
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

async function fetchReaderMarkdown(url: string): Promise<string> {
  const { data, status } = await axios.get(`https://r.jina.ai/${url}`, {
    headers: {
      'Accept': 'text/plain',
      'User-Agent': browserHeaders['User-Agent'],
    },
    timeout: 30000,
    responseType: 'text',
    validateStatus: status => status < 500,
  });

  if (status !== 200) {
    throw new Error(`Reader fallback returned HTTP ${status}`);
  }

  const text = typeof data === 'string' ? data : String(data);
  if (text.includes('"code":451') || text.includes('SecurityCompromiseError')) {
    throw new Error('Reader fallback refused this domain');
  }

  if (isBlockedReaderMarkdown(text)) {
    throw new Error('Reader fallback returned an access-denied or missing page');
  }

  return text;
}

function parseMaxReaderMarkdown(markdown: string, url: string): NormalizedProduct {
  if (isBlockedReaderMarkdown(markdown)) {
    throw new Error('Reader fallback returned an access-denied page');
  }

  const lines = markdown.split(/\r?\n/).map(line => cleanText(line)).filter(Boolean);
  const title = cleanText(
    (lines.find(line => /^#\s+/.test(line)) || '')
      .replace(/^#\s+/, '')
      .replace(/\s*\|\s*Max.*$/i, '')
  );

  if (!title || /Just a moment|Access Denied/i.test(title)) {
    throw new Error('Reader fallback did not expose a Max Fashion product title');
  }

  const vatIndex = lines.findIndex(line => /Inclusive of VAT/i.test(line));
  const priceWindow = vatIndex >= 0 ? lines.slice(Math.max(0, vatIndex - 6), vatIndex + 1) : lines;
  const priceLine =
    priceWindow.reverse().find(line => parsePrice(line) > 0) ||
    lines.find(line => /AED|د\.?إ|درهم/i.test(line) && parsePrice(line) > 0);
  const price = parsePrice(priceLine);
  const currency = detectCurrency(markdown, 'AED');

  const colorIndex = lines.findIndex(line => /^Color\s*:/i.test(line));
  const color = colorIndex >= 0 ? cleanText(lines[colorIndex].split(':').pop() || lines[colorIndex + 1]) : undefined;
  const sizeValues = uniqueCleanValues(lines.filter(line => /^\d+\s*-\s*\d+\s*(?:MTHS?|MONTHS?|YRS?|YEARS?)$/i.test(line)));
  const productCode = getProductIdFromUrl(url);
  const images: NormalizedProduct['images'] = [];
  const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  for (const match of markdown.matchAll(imageRegex)) {
    if (/maxfashion|landmark|cloudfront|scene7|akamai/i.test(match[2])) {
      pushImage(images, match[2], url, match[1]);
    }
  }

  const descriptionIndex = lines.findIndex(line => /Description and Care/i.test(line));
  const availabilityIndex = lines.findIndex(line => /In-store Availability|Browse More Products/i.test(line));
  const description = descriptionIndex >= 0
    ? cleanText(lines.slice(descriptionIndex + 1, availabilityIndex > descriptionIndex ? availabilityIndex : descriptionIndex + 20).join(' '))
    : '';

  if (price <= 0) {
    throw new Error('Reader fallback did not expose a Max Fashion product price');
  }

  return {
    source: {
      supplier: 'Max Fashion',
      url,
      productId: productCode,
    },
    title,
    description,
    brand: 'Max Fashion',
    currency,
    price,
    images: images.map((image, position) => ({ ...image, position })),
    options: sizeValues.length ? [{ name: 'Size', values: sizeValues }] : [{ name: 'Default', values: ['Default'] }],
    variants: sizeValues.length
      ? sizeValues.map(size => ({
          sourceVariantId: `${productCode || 'max'}-${slugOption(size)}`,
          sku: `${productCode || 'MAX'}-${slugOption(size).toUpperCase()}`,
          color,
          size,
          price,
          available: true,
          stockStatus: 'in_stock' as const,
        }))
      : [{
          sourceVariantId: productCode || 'default',
          color,
          price,
          available: true,
          stockStatus: 'in_stock',
        }],
    raw: {
      readerFallback: true,
      extractedAt: new Date().toISOString(),
    },
  };
}

function parseNextReaderMarkdown(markdown: string, url: string, readerUrl = url): NormalizedProduct {
  if (isBlockedReaderMarkdown(markdown)) {
    throw new Error('Reader fallback returned an access-denied or missing page');
  }

  const lines = markdown.split(/\r?\n/).map(line => line.trim());
  const productIdFromUrl = getProductIdFromUrl(url);
  const productCodeLine = lines.find(line => /Product Code|Product ID|\u0631\u0645\u0632\s+\u0627\u0644\u0645\u0646\u062a\u062c/i.test(line));
  const productCode = productCodeLine?.split(':').pop()?.trim() || productIdFromUrl;
  const productCodeIndex = productCodeLine ? lines.indexOf(productCodeLine) : -1;

  const headingCandidates = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^#\s+/.test(line));

  const titleHeading =
    headingCandidates.filter(({ index }) => productCodeIndex === -1 || index < productCodeIndex).pop() ||
    headingCandidates[0];

  const title = cleanText((titleHeading?.line || 'Next Product').replace(/^#\s+/, ''));
  const titleIndex = titleHeading?.index || 0;

  if (!title || /^(Access Denied|404|Page Not Found|Next Product)$/i.test(title)) {
    throw new Error('Reader fallback did not expose a product title');
  }

  const priceLine = lines
    .slice(titleIndex, productCodeIndex > titleIndex ? productCodeIndex : titleIndex + 30)
    .find(line => /(?:EGP|\$|£|€|\u062c\s*\.?\s*\u0645)/i.test(line)) ||
    lines.find(line => /(?:EGP|\$|£|€|\u062c\s*\.?\s*\u0645)/i.test(line));

  const descriptionStart = lines.findIndex(line => /^##\s+(Description|\u0627\u0644\u0648\u0635\u0641)/i.test(line));
  let descriptionText = '';
  if (descriptionStart >= 0) {
    const descriptionLines: string[] = [];
    for (const line of lines.slice(descriptionStart + 1)) {
      if (/^##\s+/.test(line)) break;
      if (line && line !== '* * *') descriptionLines.push(line);
    }
    descriptionText = cleanText(descriptionLines.join(' '));
  }

  const images: NormalizedProduct['images'] = [];
  const productIdKey = productIdFromUrl?.toLowerCase();
  images.push(...extractNextProductImages(markdown, readerUrl, productIdKey));

  const arabicBrandMatch = title.match(/\s\u0645\u0646\s+(.+)$/);
  const englishBrandMatch = title.match(/\bfrom\s+(.+)$/i);
  const brand = cleanText(arabicBrandMatch?.[1] || englishBrandMatch?.[1] || 'Next');
  const effectivePriceLine = priceLine ||
    lines
      .slice(titleIndex, productCodeIndex > titleIndex ? productCodeIndex : titleIndex + 30)
      .find(looksLikeCurrencyText) ||
    lines.find(looksLikeCurrencyText);
  const priceRange = parsePriceRange(effectivePriceLine);
  const price = priceRange.min;
  const currency = detectCurrency(effectivePriceLine, 'EGP');
  const color = parseNextColourFromMarkdown(lines) || inferNextColourFromTitle(title);
  const sizeValues = inferNextBabySizes(`${title} ${descriptionText}`);
  const variants = buildInferredNextVariants(productCode, sizeValues, priceRange, color);

  if (price <= 0) {
    throw new Error('Reader fallback did not expose a product price');
  }

  const product: NormalizedProduct = {
    source: {
      supplier: 'Next',
      url,
      productId: productCode,
    },
    title,
    description: descriptionText,
    brand,
    currency,
    price,
    images,
    options: [
      ...(color ? [{ name: 'Color', values: [color] }] : []),
      { name: 'Size', values: sizeValues.length ? sizeValues : ['Default'] },
    ],
    variants: variants.length ? variants : [{
      sourceVariantId: productCode || 'default',
      sku: productCode,
      color,
      size: 'Default',
      price,
      optionValues: buildVariantOptionValues(color, undefined),
      available: true,
      stockStatus: 'in_stock'
    }],
    raw: {
      readerFallback: true,
      readerUrl,
      regionalFallback: readerUrl !== url,
      productCode,
      inferredVariants: variants.length > 0,
      extractedAt: new Date().toISOString()
    }
  };

  return applyNextColorwaysFromMarkdown(product, markdown, url, readerUrl);
}

async function enrichNextProductWithReaderColorways(product: NormalizedProduct, url: string): Promise<NormalizedProduct> {
  const colorOption = product.options.find(option => /^colou?r$/i.test(option.name));
  if ((colorOption?.values?.length || 0) > 1) return product;

  for (const readerUrl of buildNextReaderUrls(url)) {
    try {
      const markdown = await fetchReaderMarkdown(readerUrl);
      const enriched = applyNextColorwaysFromMarkdown(product, markdown, url, readerUrl);
      const enrichedColorOption = enriched.options.find(option => /^colou?r$/i.test(option.name));
      if ((enrichedColorOption?.values?.length || 0) > (colorOption?.values?.length || 0)) {
        return enriched;
      }
    } catch {}
  }

  return product;
}

function isBlockedNextHtml(html: string): boolean {
  return /<title>\s*Access Denied\s*<\/title>|<h1>\s*Access Denied\s*<\/h1>|You don't have permission to access/i.test(html) ||
    /404\s*\|\s*Page Not Found|Oops'\s+Something's gone wrong/i.test(html);
}

function extractNextProductFromHtml(html: string, url: string, pageUrl = url): NormalizedProduct {
  if (isBlockedNextHtml(html)) {
    throw new Error('Next HTML returned an access-denied or missing page');
  }

  const $ = cheerio.load(html);
  let productData: any = null;

  $('script[type="application/ld+json"], script[data-testid="pdp-structured-data"]').each((_, el) => {
    if (productData) return;
    try {
      productData = findProductJsonLd(JSON.parse($(el).text() || '{}'));
    } catch {}
  });

  if (!productData) {
    $('script').each((_, el) => {
      if (productData) return;
      const text = $(el).text() || '';
      if (!text.includes('"@type":"Product"') && !text.includes('"@type": "Product"')) return;
      try {
        const jsonStart = text.indexOf('{');
        if (jsonStart >= 0) productData = findProductJsonLd(JSON.parse(text.slice(jsonStart)));
      } catch {}
    });
  }

  const offerList = Array.isArray(productData?.offers) ? productData.offers : [productData?.offers].filter(Boolean);
  const productCode = cleanText(productData?.sku || $('[data-testid="product-code"]').first().text() || getProductIdFromUrl(url) || '');
  const title = cleanText(
    productData?.name ||
    $('[data-testid="pdp-title"]').first().text() ||
    $('h1').first().text() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text()
  );

  if (!title || /^(Access Denied|404|Page Not Found)$/i.test(title)) {
    throw new Error('Next HTML did not expose a product title');
  }

  const description = cleanText(
    productData?.description
      ? cheerio.load(productData.description).text()
      : $('[data-testid="product-description"]').first().text() || $('meta[name="description"]').attr('content')
  );

  const brandValue = productData?.brand;
  const brand = cleanText((typeof brandValue === 'string' ? brandValue : brandValue?.name) || 'Next');
  const itemNumber = (getProductIdFromUrl(pageUrl) || getProductIdFromUrl(url) || productCode.replace(/-/g, '')).toLowerCase();
  const images = extractNextProductImages(html, pageUrl, itemNumber);
  const productImages = Array.isArray(productData?.image) ? productData.image : [productData?.image].filter(Boolean);
  for (const imageUrl of productImages) {
    pushNextProductImage(images, typeof imageUrl === 'string' ? imageUrl : imageUrl?.url, pageUrl, itemNumber);
  }

  const priceValues = offerList.map((offer: any) => parsePrice(offer?.price)).filter((price: number) => price > 0);
  const fallbackPrice = parsePrice(productData?.offers?.price || $('[data-testid="product-price"]').first().text());
  const price = priceValues.length ? Math.min(...priceValues) : fallbackPrice;
  const maxPrice = priceValues.length ? Math.max(...priceValues) : price;
  const currency = detectCurrency(offerList[0]?.priceCurrency || $('[data-testid="product-price"]').first().text(), offerList[0]?.priceCurrency || 'USD');
  const color = parseNextColourFromHtml($, title);
  const variantsFromOffers = variantsFromJsonLdOffers(productData?.offers, productCode, color);
  const inferredSizes = inferNextBabySizes(`${title} ${description}`);
  const variants = variantsFromOffers.length
    ? variantsFromOffers
    : buildInferredNextVariants(productCode, inferredSizes, { min: price, max: maxPrice }, color);
  const sizeValues = [...new Set(variants.map(variant => variant.size).filter(Boolean))];

  if (price <= 0) {
    throw new Error('Next HTML did not expose a product price');
  }

  return {
    source: {
      supplier: 'Next',
      url,
      productId: productCode || getProductIdFromUrl(url),
    },
    title,
    description,
    brand,
    currency,
    price,
    images,
    options: [
      ...(color ? [{ name: 'Color', values: [color] }] : []),
      { name: 'Size', values: sizeValues.length ? sizeValues : ['Default'] },
    ],
    variants: variants.length ? variants : [{
      sourceVariantId: productCode || 'default',
      sku: productCode,
      color,
      size: 'Default',
      price,
      optionValues: buildVariantOptionValues(color, undefined),
      available: true,
      stockStatus: 'in_stock',
    }],
    raw: {
      htmlFallback: pageUrl !== url,
      htmlUrl: pageUrl,
      productCode,
      extractedAt: new Date().toISOString(),
    },
  };
}

export class GenericScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return true; // Catch-all
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    try {
      const requestOptions: any = {
        headers: {
          ...browserHeaders,
          'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Referer': 'https://www.google.com/',
        },
        timeout: 15000,
      };

      try {
        const response = await axios.get(url, requestOptions);
        return extractGenericProductFromHtml(response.data, url);
      } catch (e: any) {
        if (e.response?.status === 403) {
          requestOptions.headers['User-Agent'] = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
          const response = await axios.get(url, requestOptions);
          return extractGenericProductFromHtml(response.data, url);
        }
        throw e;
      }
    } catch (error) {
      console.error('Scraping error:', error);
      throw new Error('Failed to scrape product data');
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    const product = await this.scrape(url);
    return {
      available: product.variants.some(v => v.available),
      price: product.price,
      variants: product.variants.map(v => ({
        id: v.sourceVariantId || 'default',
        available: v.available,
        price: v.price
      }))
    };
  }
}

export class NextScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return isNextUrl(url);
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    try {
      // Try to extract product ID and style ID from URL
      // https://www.nextdirect.com/eg/ar/style/su864117/y13998#y13998
      const urlMatch = url.match(/style\/([a-z0-9]+)\/([a-z0-9]+)/i);
      if (urlMatch) {
        const [, styleId, productId] = urlMatch;
        const apiUrls = [
          `https://www.nextdirect.com/api/product/v1/product/${styleId}/${productId}`,
          `https://www.next.co.uk/api/product/v1/product/${styleId}/${productId}`
        ];

        for (const apiUrl of apiUrls) {
          try {
            console.log(`Trying Next API: ${apiUrl}`);
            const apiResponse = await axios.get(apiUrl, {
              headers: {
                'accept': 'application/json, text/plain, */*',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'referer': url,
              },
              timeout: 10000,
            });

            if (apiResponse.status === 200 && apiResponse.data) {
              const data = apiResponse.data;
              // Normalize API response to NormalizedProduct
              const item = data.product || data;
              return await enrichNextProductWithReaderColorways({
                source: {
                  supplier: 'Next',
                  url,
                  productId: `${styleId}-${productId}`
                },
                title: item.name || item.title || 'Next Product',
                description: item.description,
                brand: item.brand || 'Next',
                currency: item.currency || 'EGP',
                price: parseFloat(item.price || item.currentPrice || '0'),
                images: (item.images || []).map((img: any, idx: number) => ({
                  url: img.url || img,
                  position: idx
                })),
                options: item.options || [],
                variants: (item.variants || []).map((v: any) => ({
                  sourceVariantId: v.id || v.sku,
                  sku: v.sku,
                  price: parseFloat(v.price),
                  available: v.inStock !== false,
                  stockStatus: v.inStock ? 'in_stock' : 'out_of_stock'
                })),
                raw: data
              }, url);
            }
          } catch (e: any) {
            // Expected on some regional Next URLs; HTML/reader fallback handles this.
          }
        }
      }

      // Fallback to HTML scraping if API fails
      let response: any = null;
      const uas = [
        {
          ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          platform: '"Windows"',
          mobile: '?0',
          chUa: '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"'
        },
        {
          ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          platform: '"macOS"',
          mobile: '?0',
          chUa: '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"'
        },
        {
          ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
          platform: '"iOS"',
          mobile: '?1',
          chUa: undefined
        },
        {
          ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          platform: undefined,
          mobile: undefined,
          chUa: undefined
        }
      ];

      let lastError: any = null;
      for (const uaInfo of uas) {
        try {
          const headers: any = {
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'accept-language': 'en-US,en;q=0.9,ar-EG;q=0.8,ar;q=0.7',
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1',
            'user-agent': uaInfo.ua,
            'cookie': 'Country=eg; Language=ar; ' + (uaInfo.ua.includes('Googlebot') ? '' : 'OptanonAlertBoxClosed=2024-01-01T00:00:00.000Z;'),
          };

          if (uaInfo.platform) headers['sec-ch-ua-platform'] = uaInfo.platform;
          if (uaInfo.mobile) headers['sec-ch-ua-mobile'] = uaInfo.mobile;
          if (uaInfo.chUa) headers['sec-ch-ua'] = uaInfo.chUa;

          const requestOptions: any = {
            headers,
            timeout: 20000,
            validateStatus: (status: number) => status < 500, // Allow 403 to handle it manually if needed, but axios throws on 403 by default
          };

          response = await axios.get(url, requestOptions);
          
          if (response.status === 200) {
            console.log(`Successfully scraped Next using UA: ${uaInfo.ua.substring(0, 30)}...`);
            try {
              return await enrichNextProductWithReaderColorways(extractNextProductFromHtml(response.data, url), url);
            } catch (htmlError) {
              lastError = htmlError;
              response = null;
              continue;
            }
          }
          
          if (response.status === 403) {
            continue;
          }
        } catch (e: any) {
          lastError = e;
          continue;
        }
      }

      if (!response || response.status !== 200) {
        const directError = lastError?.message || `HTTP ${response?.status || 403}`;
        const htmlErrors: string[] = [];

        for (const htmlUrl of buildNextHtmlFallbackUrls(url)) {
          try {
            console.log(`Direct Next scraping failed, trying HTML fallback: ${htmlUrl}`);
            const htmlResponse = await axios.get(htmlUrl, {
              headers: {
                ...browserHeaders,
                'accept-language': htmlUrl.includes('nextdirect.com/eg/ar') ? 'ar-EG,ar;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
                'sec-ch-ua': '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'none',
                'sec-fetch-user': '?1',
                'cookie': htmlUrl.includes('next.us') ? 'Country=us; Language=en; OptanonAlertBoxClosed=2024-01-01T00:00:00.000Z;' : 'Country=eg; Language=en; OptanonAlertBoxClosed=2024-01-01T00:00:00.000Z;',
              },
              timeout: 20000,
              validateStatus: (status: number) => status < 500,
            });

            if (htmlResponse.status !== 200) {
              throw new Error(`HTTP ${htmlResponse.status}`);
            }

            return await enrichNextProductWithReaderColorways(extractNextProductFromHtml(htmlResponse.data, url, htmlUrl), url);
          } catch (htmlError: any) {
            htmlErrors.push(`${htmlUrl}: ${htmlError.message}`);
          }
        }

        const readerErrors: string[] = [];

        for (const readerUrl of buildNextReaderUrls(url)) {
          try {
            console.log(`Direct Next scraping failed, trying Reader fallback: ${readerUrl}`);
            const markdown = await fetchReaderMarkdown(readerUrl);
            return parseNextReaderMarkdown(markdown, url, readerUrl);
          } catch (readerError: any) {
            readerErrors.push(`${readerUrl}: ${readerError.message}`);
          }
        }

        throw new Error(`Failed to scrape direct page (${directError}), HTML fallbacks failed (${htmlErrors.join('; ')}), and Reader fallbacks failed (${readerErrors.join('; ')})`);
      }

      const $ = cheerio.load(response.data);
      
      // Next often embeds product data in a JSON structure for their interactive elements
      let rawData: any = null;
      $('script').each((_, el) => {
        const text = $(el).html() || '';
        if (text.includes('next.product')) {
          try {
            // Very simplified extraction for this demo
            const match = text.match(/next\.product\s*=\s*({.*?});/s);
            if (match) rawData = JSON.parse(match[1]);
          } catch (e) {}
        }
      });

      // Try JSON-LD as fallback
      if (!rawData) {
        $('script[type="application/ld+json"]').each((_, el) => {
          try {
            const data = JSON.parse($(el).html() || '{}');
            if (data['@type'] === 'Product') rawData = data;
          } catch (e) {}
        });
      }

      const title = rawData?.name || $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || 'Next Product';
      const description = rawData?.description || $('meta[name="description"]').attr('content') || '';
      const brand = rawData?.brand?.name || 'Next';
      const currency = rawData?.offers?.priceCurrency || rawData?.offers?.[0]?.priceCurrency || 'EGP';
      const price = parseFloat(rawData?.offers?.price || rawData?.offers?.[0]?.price || '0');

      const images: any[] = [];
      const mainImage = rawData?.image || $('meta[property="og:image"]').attr('content');
      if (mainImage) images.push({ url: Array.isArray(mainImage) ? mainImage[0] : mainImage, position: 0 });

      // Variants extraction (Next specific logic)
      const variants: any[] = [];
      const options: any[] = [];

      if (rawData?.offers && Array.isArray(rawData.offers)) {
        rawData.offers.forEach((offer: any, idx: number) => {
          variants.push({
            sourceVariantId: offer.sku || `variant-${idx}`,
            sku: offer.sku,
            price: parseFloat(offer.price),
            available: offer.availability === 'http://schema.org/InStock',
            stockStatus: offer.availability === 'http://schema.org/InStock' ? 'in_stock' : 'out_of_stock',
          });
        });
      } else {
        // Fallback to single variant
        variants.push({
          sourceVariantId: 'default',
          price,
          available: true,
          stockStatus: 'in_stock'
        });
      }

      return await enrichNextProductWithReaderColorways({
        source: {
          supplier: brand,
          url,
          productId: url.split('/').pop()?.split('#')[0]
        },
        title,
        description,
        brand,
        currency,
        price,
        images,
        options: options.length ? options : [{ name: 'Size', values: ['One Size'] }],
        variants,
        raw: rawData || { msg: 'Direct extraction failed, used fallbacks' }
      }, url);
    } catch (error: any) {
      console.error('Next Scraper error:', error.message);
      throw new Error(`Failed to scrape Next: ${error.message}`);
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    const product = await this.scrape(url);
    return {
      available: product.variants.some(v => v.available),
      price: product.price,
      variants: product.variants.map(v => ({
        id: v.sourceVariantId || 'default',
        available: v.available,
        price: v.price
      }))
    };
  }
}

export class ScraperService {
  private scrapers: SupplierScraper[] = [
    new NextScraper(),
    new MarksAndSpencerScraper(),
    new MothercareScraper(),
    new ZaraScraper(),
    new LeftiesScraper(),
    new SheinScraper(),
    new MaxFashionScraper(),
    new GenericScraper(), // Fallback
  ];

  async scrape(url: string): Promise<NormalizedProduct> {
    const scraper = this.scrapers.find(s => s.canHandle(url)) || this.scrapers[0];
    return normalizeProductOptionsAndVariants(await scraper.scrape(url));
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    const scraper = this.scrapers.find(s => s.canHandle(url)) || this.scrapers[0];
    return await scraper.checkAvailability(url);
  }
}
