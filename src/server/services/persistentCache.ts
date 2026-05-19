import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type PersistedEntry<T> = {
  key: string;
  expiresAt: number;
  value: T;
};

type PersistedCacheFile<T> = {
  version: 1;
  entries: Record<string, PersistedEntry<T>>;
};

export class PersistentJsonCache<T> {
  private loaded = false;
  private dirty = false;
  private entries = new Map<string, PersistedEntry<T>>();

  constructor(
    private readonly filePath: string,
    private readonly options: { maxEntries?: number } = {},
  ) {}

  get(key: string): T | undefined {
    this.ensureLoaded();
    this.pruneExpired();

    const cacheKey = this.hashKey(key);
    const entry = this.entries.get(cacheKey);
    if (!entry || entry.key !== key) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(cacheKey);
      this.flushIfDirty();
      return undefined;
    }

    return this.clone(entry.value);
  }

  set(key: string, value: T, ttlMs: number) {
    if (ttlMs <= 0) return;
    this.ensureLoaded();

    this.entries.set(this.hashKey(key), {
      key,
      expiresAt: Date.now() + ttlMs,
      value: this.clone(value),
    });

    this.pruneExpired();
    this.pruneToMaxEntries();
    this.dirty = true;
    this.flushIfDirty();
  }

  has(key: string): boolean {
    return Boolean(this.get(key));
  }

  stats() {
    this.ensureLoaded();
    this.pruneExpired();
    return {
      filePath: this.resolvePath(),
      entries: this.entries.size,
    };
  }

  private ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;

    try {
      const raw = fs.readFileSync(this.resolvePath(), "utf8");
      const parsed = JSON.parse(raw) as PersistedCacheFile<T>;
      if (!parsed || parsed.version !== 1 || !parsed.entries) return;

      this.entries = new Map(Object.entries(parsed.entries));
      this.pruneExpired();
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        console.warn(
          "Persistent cache could not be loaded:",
          error?.message || error,
        );
      }
    }
  }

  private pruneExpired() {
    const now = Date.now();
    let changed = false;
    for (const [cacheKey, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(cacheKey);
        changed = true;
      }
    }

    if (changed) {
      this.dirty = true;
    }
  }

  private pruneToMaxEntries() {
    const maxEntries = Math.max(0, this.options.maxEntries || 0);
    if (!maxEntries || this.entries.size <= maxEntries) return;

    const ordered = [...this.entries.entries()].sort(
      (a, b) => a[1].expiresAt - b[1].expiresAt,
    );
    for (const [cacheKey] of ordered.slice(0, this.entries.size - maxEntries)) {
      this.entries.delete(cacheKey);
    }
  }

  private flushIfDirty() {
    if (!this.dirty) return;
    this.dirty = false;

    try {
      const resolved = this.resolvePath();
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      const payload: PersistedCacheFile<T> = {
        version: 1,
        entries: Object.fromEntries(this.entries),
      };
      const tempPath = `${resolved}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(payload), "utf8");
      fs.renameSync(tempPath, resolved);
    } catch (error: any) {
      console.warn(
        "Persistent cache could not be saved:",
        error?.message || error,
      );
    }
  }

  private resolvePath() {
    return path.isAbsolute(this.filePath)
      ? this.filePath
      : path.join(process.cwd(), this.filePath);
  }

  private hashKey(key: string) {
    return crypto.createHash("sha256").update(key).digest("hex");
  }

  private clone(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }
}
