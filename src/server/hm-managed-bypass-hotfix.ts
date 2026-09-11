import * as cheerio from 'cheerio';
import {
  HmScraper,
  fetchHtmlViaManagedBypass,
  type NormalizedProduct,
} from './services/scraper.js';

let installed = false;

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(value: unknown, baseUrl: string) {
  const raw = clean(value);
  if (!raw || /^data:/i.test(raw)) return '';
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return '';
  }
}

function firstJsonLdProduct($: cheerio.CheerioAPI): any | null {
  let found: any = null;
  $('script[type="application/ld+json"]').each((_, element) => {
    if (found) return;
    const raw = $(element).text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of values) {
        const graph = Array.isArray(value?.['@graph']) ? value['@graph'] : [value];
        const product = graph.find((entry: any) => {
          const type = entry?.['@type'];
          return Array.isArray(type) ? type.includes('Product') : type === 'Product';
        });
        if (product) {
          found = product;
          break;
        }
      }
    } catch {}
  });
  return found;
}

function hmSizeCandidates($: cheerio.CheerioAPI) {
  const candidates = new Set<string>();
  const selectors = [
    '[data-testid*="size"] button',
    '[data-testid*="size"] option',
    '[class*="size"] button',
    '[class*="size"] option',
    'select option',
    'button',
  ].join(',');

  $(selectors).each((_, element) => {
    const text = clean($(element).attr('value') || $(element).text())
      .replace(/^(?:size|select size)\s*:?\s*/i, '')
      .replace(/\s*(?:sold out|out of stock|notify me)\s*$/i, '')
      .trim();
    if (!text || text.length > 24) return;

    const isNamedSize = /^(?:XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|6XL)$/i.test(text);
    const isAgeSize = /^\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*(?:M|MTHS?|MONTHS?|Y|YRS?|YEARS?)$/i.test(text) ||
      /^\d+(?:\.\d+)?\s*(?:M|MTHS?|MONTHS?|Y|YRS?|YEARS?)$/i.test(text);
    const isNumericSize = /^(?:EU(?:R)?\s*)?\d{2,3}(?:\s*\/\s*\d{2,3})?$/i.test(text);
    const isBraLike = /^\d{2,3}[A-H]{1,2}$/i.test(text);

    if (isNamedSize || isAgeSize || isNumericSize || isBraLike) {
      candidates.add(text.replace(/^EU(?:R)?\s*/i, ''));
    }
  });

  return [...candidates].slice(0, 100);
}

function buildHmSnapshot(html: string, url: string) {
  const $ = cheerio.load(html);
  const jsonLd = firstJsonLdProduct($);
  const offer = Array.isArray(jsonLd?.offers) ? jsonLd.offers[0] : jsonLd?.offers;
  const title = clean(
    jsonLd?.name ||
      $('h1').first().text() ||
      $('meta[property="og:title"]').attr('content') ||
      $('title').text(),
  );
  const description = clean(
    jsonLd?.description ||
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      $('[data-testid*="description"]').first().text(),
  );

  const bodyText = clean($('body').text());
  const metaPrice = clean(
    $('meta[property="product:price:amount"]').attr('content') ||
      $('meta[itemprop="price"]').attr('content') ||
      offer?.price,
  );
  const bodyPrice = bodyText.match(/(?:AED|د\.?إ\.?)\s*([0-9]+(?:[.,][0-9]+)?)/i)?.[1] || '';
  const price = metaPrice || bodyPrice;

  const images = new Set<string>();
  const addImage = (value: unknown) => {
    const resolved = absoluteUrl(value, url);
    if (!resolved) return;
    if (!/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(resolved)) return;
    if (/logo|icon|sprite|payment|flag|placeholder/i.test(resolved)) return;
    images.add(resolved);
  };

  const jsonImages = Array.isArray(jsonLd?.image) ? jsonLd.image : [jsonLd?.image];
  jsonImages.forEach(addImage);
  addImage($('meta[property="og:image"]').attr('content'));
  addImage($('meta[property="product:image"]').attr('content'));
  $('img').slice(0, 80).each((_, element) => {
    addImage(
      $(element).attr('src') ||
        $(element).attr('data-src') ||
        $(element).attr('data-original') ||
        $(element).attr('srcset')?.split(',')[0]?.trim().split(/\s+/)[0],
    );
  });

  const sizes = hmSizeCandidates($);
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`);
  if (price) lines.push(`Price: AED ${price}`);
  if (description) {
    lines.push('Description');
    lines.push(description);
  }
  for (const image of [...images].slice(0, 24)) {
    lines.push(`![${title || 'H&M product'}](${image})`);
  }
  for (const size of sizes) lines.push(size);

  return {
    markdown: lines.join('\n'),
    sizes,
    title,
  };
}

function normalizeHmSizes(product: NormalizedProduct, sizes: string[]) {
  if (sizes.length <= 1) return product;

  const color = product.variants.find((variant) => variant.color)?.color;
  const imageUrl = product.images[0]?.url;
  product.options = [
    ...(color ? [{ name: 'Color', values: [color] }] : []),
    { name: 'Size', values: sizes },
  ];
  product.variants = sizes.map((size, index) => ({
    sourceVariantId: `${product.source.productId || 'hm'}-${index + 1}-${size.replace(/[^a-z0-9]+/gi, '-')}`,
    color,
    size,
    price: product.price,
    currency: product.currency,
    optionValues: {
      ...(color ? { Color: color } : {}),
      Size: size,
    },
    available: true,
    stockStatus: 'unknown' as const,
    imageUrl,
    raw: { hmManagedBypassFallback: true },
  }));
  return product;
}

export function installHmManagedBypassHotfix() {
  if (installed) return;
  installed = true;

  const originalScrape = HmScraper.prototype.scrape;
  HmScraper.prototype.scrape = async function hmScrapeWithManagedFallback(url: string) {
    try {
      return await originalScrape.call(this, url);
    } catch (error: any) {
      const code = clean(error?.code);
      const message = clean(error?.message || error);
      const blocked = code === 'SOURCE_BLOCKED' || /H&M did not expose usable product data/i.test(message);
      if (!blocked) throw error;

      try {
        const html = await fetchHtmlViaManagedBypass(url, {
          deviceType: 'mobile',
          jsRender: true,
          premium: true,
        });
        const snapshot = buildHmSnapshot(html, url);
        if (!snapshot.title || !snapshot.markdown.includes('Price: AED')) {
          throw new Error('managed H&M page did not expose a trustworthy title and AED price');
        }
        const parsed = this.scrapeSnapshot(url, snapshot.markdown);
        const normalized = normalizeHmSizes(parsed, snapshot.sizes);
        normalized.raw = {
          ...(normalized.raw || {}),
          hmManagedBypassFallback: true,
          hmManagedBypassSizes: snapshot.sizes.length,
        };
        console.log(`[hm-hotfix] managed fallback succeeded: sizes=${snapshot.sizes.length} url=${url}`);
        return normalized;
      } catch (fallbackError: any) {
        console.warn(`[hm-hotfix] managed fallback failed: ${clean(fallbackError?.message || fallbackError)}`);
        throw error;
      }
    }
  };

  console.log('[hm-hotfix] managed bypass fallback installed');
}

installHmManagedBypassHotfix();
