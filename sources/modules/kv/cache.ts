/**
 * KV Cache wrapper module
 *
 * Provides a simple caching interface using Cloudflare KV.
 * Replaces the database-based simpleCache with KV for better performance.
 */

/**
 * Cache wrapper for Cloudflare KV
 */
export class KVCache {
    private kv: KVNamespace;
    private prefix: string;

    constructor(kv: KVNamespace, prefix: string = "cache:") {
        this.kv = kv;
        this.prefix = prefix;
    }

    /**
     * Get a cached value by key.
     *
     * @param key - Cache key
     * @returns The cached value or null if not found/expired
     */
    async get<T>(key: string): Promise<T | null> {
        const value = await this.kv.get(this.prefixKey(key), "json");
        return value as T | null;
    }

    /**
     * Get a cached string value.
     *
     * @param key - Cache key
     * @returns The cached string or null if not found/expired
     */
    async getText(key: string): Promise<string | null> {
        return this.kv.get(this.prefixKey(key), "text");
    }

    /**
     * Set a cached value with optional TTL.
     *
     * @param key - Cache key
     * @param value - Value to cache (will be JSON serialized)
     * @param ttlSeconds - Time to live in seconds (optional)
     */
    async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
        const options: KVNamespacePutOptions = {};
        if (ttlSeconds) {
            options.expirationTtl = ttlSeconds;
        }
        await this.kv.put(this.prefixKey(key), JSON.stringify(value), options);
    }

    /**
     * Set a string value with optional TTL.
     *
     * @param key - Cache key
     * @param value - String value to cache
     * @param ttlSeconds - Time to live in seconds (optional)
     */
    async setText(key: string, value: string, ttlSeconds?: number): Promise<void> {
        const options: KVNamespacePutOptions = {};
        if (ttlSeconds) {
            options.expirationTtl = ttlSeconds;
        }
        await this.kv.put(this.prefixKey(key), value, options);
    }

    /**
     * Delete a cached value.
     *
     * @param key - Cache key to delete
     */
    async delete(key: string): Promise<void> {
        await this.kv.delete(this.prefixKey(key));
    }

    /**
     * List keys with a given prefix.
     *
     * @param keyPrefix - Additional prefix to filter keys
     * @param limit - Maximum number of keys to return (default 1000)
     * @returns Array of keys (without the cache prefix)
     */
    async list(keyPrefix: string = "", limit: number = 1000): Promise<string[]> {
        const fullPrefix = this.prefixKey(keyPrefix);
        const result = await this.kv.list({ prefix: fullPrefix, limit });
        return result.keys.map((k) => k.name.slice(this.prefix.length));
    }

    /**
     * Get or set a cached value.
     * If the key doesn't exist, calls the factory function and caches the result.
     *
     * @param key - Cache key
     * @param factory - Function to create the value if not cached
     * @param ttlSeconds - Time to live in seconds (optional)
     * @returns The cached or newly created value
     */
    async getOrSet<T>(
        key: string,
        factory: () => Promise<T>,
        ttlSeconds?: number
    ): Promise<T> {
        const cached = await this.get<T>(key);
        if (cached !== null) {
            return cached;
        }

        const value = await factory();
        await this.set(key, value, ttlSeconds);
        return value;
    }

    private prefixKey(key: string): string {
        return `${this.prefix}${key}`;
    }
}

/**
 * Create a KV cache instance from environment bindings.
 *
 * @param kv - KV namespace binding
 * @param prefix - Optional key prefix
 * @returns Configured KVCache instance
 */
export function createCache(kv: KVNamespace, prefix?: string): KVCache {
    return new KVCache(kv, prefix);
}
