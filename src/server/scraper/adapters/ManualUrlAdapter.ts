import type { SourceAdapter, SourceInput } from "../types/source.js";
import { StaticHtmlProductAdapter } from "./StaticHtmlProductAdapter.js";
import { BrowserRenderedProductAdapter } from "./BrowserRenderedProductAdapter.js";

export class ManualUrlAdapter implements SourceAdapter {
  name = "manual_url";
  private staticAdapter = new StaticHtmlProductAdapter();
  private browserAdapter = new BrowserRenderedProductAdapter();

  async canHandle(input: SourceInput) {
    return input.sourceType === "product_url" && (!input.mode || input.mode === "auto");
  }

  async test(input: SourceInput) {
    const staticResult = await this.staticAdapter.test(input);
    if (staticResult.ok) return staticResult;
    if (staticResult.status === "NO_PRODUCT_DATA_FOUND" || staticResult.status === "JS_RENDER_REQUIRED") {
      return this.browserAdapter.test({ ...input, mode: "browser_rendered" });
    }
    return staticResult;
  }

  async extract(input: SourceInput) {
    const staticResult = await this.staticAdapter.extract({ ...input, mode: "static_html" }).catch((error) => ({ error }));
    if (!("error" in staticResult) && staticResult.products[0]?.confidence.overall >= 70) return staticResult;
    return this.browserAdapter.extract({ ...input, mode: "browser_rendered" });
  }
}
