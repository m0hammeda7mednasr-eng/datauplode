export type ParsedPrice = {
  amount?: number;
  currency?: string;
  raw: string;
};

const currencySignals: Array<[RegExp, string]> = [
  [/\bUSD\b|\$/i, "USD"],
  [/\bEUR\b|€/i, "EUR"],
  [/\bGBP\b|£/i, "GBP"],
  [/\bEGP\b|ج\s*\.?\s*م|جنيه/i, "EGP"],
  [/\bAED\b|د\s*\.?\s*إ|درهم/i, "AED"],
  [/\bSAR\b|ر\s*\.?\s*س|ريال/i, "SAR"],
  [/\bQAR\b/i, "QAR"],
  [/\bKWD\b/i, "KWD"],
  [/\bBHD\b/i, "BHD"],
  [/\bOMR\b/i, "OMR"],
  [/\bTRY\b|₺|\bTL\b/i, "TRY"],
];

function normalizeDigits(value: string) {
  const digits: Record<string, string> = {
    "\u0660": "0",
    "\u0661": "1",
    "\u0662": "2",
    "\u0663": "3",
    "\u0664": "4",
    "\u0665": "5",
    "\u0666": "6",
    "\u0667": "7",
    "\u0668": "8",
    "\u0669": "9",
    "\u06F0": "0",
    "\u06F1": "1",
    "\u06F2": "2",
    "\u06F3": "3",
    "\u06F4": "4",
    "\u06F5": "5",
    "\u06F6": "6",
    "\u06F7": "7",
    "\u06F8": "8",
    "\u06F9": "9",
  };
  return value.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (digit) => digits[digit] || digit);
}

function parseLocalizedNumber(value: string) {
  const normalized = normalizeDigits(value)
    .replace(/\u066B/g, ".")
    .replace(/\u066C/g, ",")
    .replace(/[\s\u00a0]/g, "");
  const match = normalized.match(/\d[\d.,]*/);
  if (!match) return undefined;

  const token = match[0];
  const lastDot = token.lastIndexOf(".");
  const lastComma = token.lastIndexOf(",");
  let decimalSeparator = "";
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSeparator = lastDot > lastComma ? "." : ",";
  } else if (lastComma >= 0) {
    const tail = token.length - lastComma - 1;
    decimalSeparator = tail > 0 && tail <= 2 ? "," : "";
  } else if (lastDot >= 0) {
    const tail = token.length - lastDot - 1;
    decimalSeparator = tail > 0 && tail <= 2 ? "." : "";
  }

  const canonical = decimalSeparator
    ? `${token.slice(0, token.lastIndexOf(decimalSeparator)).replace(/[.,]/g, "")}.${token
        .slice(token.lastIndexOf(decimalSeparator) + 1)
        .replace(/[.,]/g, "")}`
    : token.replace(/[.,]/g, "");
  const amount = Number(canonical);
  return Number.isFinite(amount) ? amount : undefined;
}

export function detectCurrency(value: string, fallback?: string) {
  for (const [pattern, currency] of currencySignals) {
    if (pattern.test(value)) return currency;
  }
  return fallback;
}

export function parsePrice(input: string | number | undefined | null): ParsedPrice {
  const raw = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { raw };
  if (typeof input === "number" && Number.isFinite(input)) {
    return { amount: input, raw };
  }
  return {
    amount: parseLocalizedNumber(raw),
    currency: detectCurrency(raw),
    raw,
  };
}
