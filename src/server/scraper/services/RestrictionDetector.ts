import type { CapabilityWarningCode, RestrictionSignals } from "../types/capability.js";

export class RestrictionDetector {
  detectRestrictionSignals(html: string, statusCode: number): RestrictionSignals {
    const body = String(html || "").toLowerCase();
    const visibleText = this.extractVisibleText(body);

    return {
      captchaDetected: this.includesAny(body, [
        "captcha",
        "recaptcha",
        "hcaptcha",
        "turnstile",
        "verify you are human",
        "prove you are human",
        "i am not a robot",
      ]),
      loginRequired: this.includesAny(visibleText, [
        "login required",
        "please log in",
        "please sign in",
        "authentication required",
        "sign in to continue",
        "member login",
      ]),
      accessDenied:
        statusCode === 401 ||
        statusCode === 403 ||
        this.includesAny(visibleText, [
          "access denied",
          "forbidden",
          "permission denied",
          "you don't have permission",
          "not authorized",
          "request blocked",
        ]),
      botProtectionPage:
        this.includesAny(body, [
          "cf-chl-",
          "cf-browser-verification",
          "challenge-form",
          "datadome",
          "perimeterx",
          "incapsula",
          "attention required",
          "checking your browser before accessing",
          "security check to access",
          "please enable cookies",
        ]) ||
        this.includesAny(visibleText, [
          "verify you are human",
          "unusual traffic",
          "automated requests",
          "ddos protection",
          "security service",
        ]),
      geoBlocked: this.includesAny(visibleText, [
        "not available in your country",
        "not available in your region",
        "geo blocked",
        "geographic restriction",
        "country restriction",
      ]),
      rateLimited:
        statusCode === 429 ||
        this.includesAny(visibleText, [
          "too many requests",
          "temporarily blocked",
          "request limit exceeded",
          "rate limit exceeded",
          "retry later",
          "try again later",
        ]),
      httpStatus: statusCode || undefined,
    };
  }

  isSafeToExtract(signals: RestrictionSignals): boolean {
    return !(
      signals.captchaDetected ||
      signals.loginRequired ||
      signals.accessDenied ||
      signals.botProtectionPage ||
      signals.geoBlocked ||
      signals.rateLimited
    );
  }

  getRestrictionReason(signals: RestrictionSignals): string | null {
    if (signals.captchaDetected) return "CAPTCHA or human verification page detected.";
    if (signals.loginRequired) return "Login required to access product content.";
    if (signals.accessDenied) return "Access denied / forbidden response detected.";
    if (signals.botProtectionPage) return "Bot protection or cloud security page detected.";
    if (signals.geoBlocked) return "Content appears geo-restricted.";
    if (signals.rateLimited) return "Rate limit or temporary block detected.";
    return null;
  }

  getWarningCode(signals: RestrictionSignals): CapabilityWarningCode | null {
    if (signals.captchaDetected) return "CAPTCHA_DETECTED";
    if (signals.loginRequired) return "LOGIN_REQUIRED";
    if (signals.accessDenied) return "ACCESS_DENIED";
    if (signals.botProtectionPage) return "BOT_PROTECTION";
    if (signals.geoBlocked) return "GEO_BLOCKED";
    if (signals.rateLimited) return "MANUAL_REVIEW_REQUIRED";
    return null;
  }

  private includesAny(text: string, patterns: string[]) {
    return patterns.some((pattern) => text.includes(pattern));
  }

  private extractVisibleText(htmlLower: string) {
    return htmlLower
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

export function detectRestrictionSignals(html: string, statusCode: number) {
  return new RestrictionDetector().detectRestrictionSignals(html, statusCode);
}
