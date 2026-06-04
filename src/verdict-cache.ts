// LRU cache for classifier verdicts. Caches command+cwd → Classification to skip
// repeat Claude calls for identical commands. In-memory, scoped to the worker
// process lifetime.
import type { Classification } from "./classify.js";

/**
 * Simple LRU cache for classifier verdicts. When the cache is full, the least
 * recently accessed entry is evicted. Access order is tracked by deleting and
 * re-inserting on get, so Map iteration order reflects LRU.
 */
export class VerdictCache {
  private cache = new Map<string, Classification>();

  constructor(private maxSize = 100) {
    if (maxSize < 1) throw new Error("VerdictCache maxSize must be >= 1");
  }

  /** Build cache key from command and cwd. JSON-encode so a command containing the separator can't
   *  collide two distinct (command, cwd) pairs onto one key (e.g. cmd "ls" + cwd "/a::b"). */
  private key(command: string, cwd: string): string {
    return JSON.stringify([command, cwd]);
  }

  /** Get cached verdict, or undefined if not found. Updates access order. */
  get(command: string, cwd: string): Classification | undefined {
    const k = this.key(command, cwd);
    const entry = this.cache.get(k);
    if (!entry) return undefined;
    // Move to end (most recent) by deleting and re-inserting.
    this.cache.delete(k);
    this.cache.set(k, entry);
    return entry;
  }

  /** Store a verdict. Evicts LRU entry if cache is full. */
  set(command: string, cwd: string, classification: Classification): void {
    const k = this.key(command, cwd);
    // If already present, delete it so we can re-insert at the end.
    if (this.cache.has(k)) {
      this.cache.delete(k);
    } else if (this.cache.size >= this.maxSize) {
      // Evict the first (least recently used) entry.
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(k, classification);
  }

  /** Current cache size. */
  size(): number {
    return this.cache.size;
  }

  /** Clear all entries. */
  clear(): void {
    this.cache.clear();
  }
}

/** Shared singleton cache for production use. */
let sharedCache: VerdictCache | null = null;

export function getSharedCache(): VerdictCache {
  if (!sharedCache) sharedCache = new VerdictCache();
  return sharedCache;
}
