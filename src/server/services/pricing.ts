import { PricingRule } from '@prisma/client';

export class PricingEngine {
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
