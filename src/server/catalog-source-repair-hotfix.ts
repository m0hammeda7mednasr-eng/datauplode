import { prisma } from './db.js';
import { ScraperService, type NormalizedProduct } from './services/scraper.js';

let installed = false;

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeFreshOptions(product: NormalizedProduct) {
  if (product.options?.length) return;

  const colors = [...new Set(product.variants.map((variant) => clean(variant.color)).filter(Boolean))];
  const sizes = [...new Set(product.variants.map((variant) => clean(variant.size)).filter(Boolean))];

  product.options = [
    ...(colors.length ? [{ name: 'Color', values: colors }] : []),
    ...(sizes.length ? [{ name: 'Size', values: sizes }] : []),
  ];

  if (product.options.length === 0 && product.variants.length === 1) {
    product.options = [{ name: 'Default', values: ['Default'] }];
  }

  for (const variant of product.variants) {
    variant.optionValues = {
      ...(variant.optionValues || {}),
      ...(variant.color ? { Color: variant.color } : {}),
      ...(variant.size ? { Size: variant.size } : {}),
      ...(!variant.color && !variant.size && product.variants.length === 1 ? { Default: 'Default' } : {}),
    };
  }
}

export function installCatalogSourceRepairHotfix() {
  if (installed) return;
  installed = true;

  const originalScrape = ScraperService.prototype.scrape;
  ScraperService.prototype.scrape = async function scrapeWithStoredStaticRepair(url: string) {
    const fresh = await originalScrape.call(this, url);
    normalizeFreshOptions(fresh);

    const needsDescription = !clean(fresh.description);
    const needsImages = !Array.isArray(fresh.images) || fresh.images.length === 0;
    if (!needsDescription && !needsImages) return fresh;

    try {
      const stored = await prisma.sourceProduct.findFirst({
        where: { url },
        select: {
          description: true,
          images: {
            orderBy: { position: 'asc' },
            select: { url: true, alt: true, color: true, position: true },
          },
        },
      });

      const repaired: string[] = [];
      if (needsDescription && clean(stored?.description)) {
        fresh.description = stored?.description || undefined;
        repaired.push('description');
      }
      if (needsImages && stored?.images?.length) {
        fresh.images = stored.images.map((image, index) => ({
          url: image.url,
          alt: image.alt || fresh.title,
          color: image.color || undefined,
          position: Number.isFinite(image.position) ? image.position : index,
        }));
        repaired.push('images');
      }

      if (repaired.length) {
        fresh.raw = {
          ...(fresh.raw || {}),
          storedStaticRepair: repaired,
        };
        console.log(`[catalog-source-repair] restored ${repaired.join('+')} for ${url}`);
      }
    } catch (error: any) {
      console.warn(`[catalog-source-repair] lookup failed: ${clean(error?.message || error)}`);
    }

    return fresh;
  };

  console.log('[catalog-source-repair] stored static-field repair installed');
}

installCatalogSourceRepairHotfix();
