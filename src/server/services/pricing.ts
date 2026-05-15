import { PricingRule } from '@prisma/client';

export class PricingEngine {
  static selectBestRule(
    rules: PricingRule[],
    context: { supplierId?: string | null; currency?: string | null } = {},
  ): PricingRule | null {
    if (!rules.length) return null;

    const currency = String(context.currency || '').trim().toUpperCase();
    const supplierId = context.supplierId || null;
    const eligibleRules = rules.filter((rule) => {
      const ruleCurrency = String(rule.currency || '').trim().toUpperCase();
      const supplierMatches = !rule.supplierId || (supplierId && rule.supplierId === supplierId);
      const currencyMatches = !ruleCurrency || !currency || ruleCurrency === currency;
      return supplierMatches && currencyMatches;
    });

    const candidates = eligibleRules.length ? eligibleRules : rules;

    return [...candidates].sort((a, b) => {
      const scoreRule = (rule: PricingRule) => {
        const ruleCurrency = String(rule.currency || '').trim().toUpperCase();
        let score = 0;

        if (supplierId && rule.supplierId === supplierId) score += 100;
        else if (!rule.supplierId) score += 10;
        else score -= 100;

        if (currency && ruleCurrency === currency) score += 30;
        else if (!ruleCurrency) score += 5;
        else score -= 20;

        if (rule.isDefault) score += 15;
        return score;
      };

      return scoreRule(b) - scoreRule(a);
    })[0] || null;
  }

  static calculatePrice(basePrice: number, rule: PricingRule): number {
    let price = basePrice;

    // Apply multiplier
    price *= rule.multiplier;

    // Apply fixed markup
    price += rule.fixedMarkup;

    // Apply percentage markup
    price += (basePrice * rule.percentageMarkup) / 100;

    // Rounding rules
    if (rule.rounding === '.99') {
      price = Math.floor(price) + 0.99;
    } else if (rule.rounding === '.00') {
      price = Math.round(price);
    }

    // Min/Max bounds
    if (rule.minPrice && price < rule.minPrice) price = rule.minPrice;
    if (rule.maxPrice && price > rule.maxPrice) price = rule.maxPrice;

    return parseFloat(price.toFixed(2));
  }

  static validatePrice(price: number): boolean {
    return !isNaN(price) && price > 0 && isFinite(price);
  }
}
