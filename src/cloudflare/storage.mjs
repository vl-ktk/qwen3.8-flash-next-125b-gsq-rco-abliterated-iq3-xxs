// KV interface expected by the copied provider, backed ONLY by Qwen's SQLite DO.
// The caller wraps each OAuth operation in storage.transaction(), including crypto
// awaits, so concurrent exchanges cannot consume the same code/refresh token.
export class OAuthStorage {
  constructor(storage) { this.storage = storage; }

  async get(key, options) {
    const record = await this.storage.get(key);
    if (!record || (record.expiration && record.expiration <= Date.now() / 1000)) return null;
    return (options === "json" || options?.type === "json") ? JSON.parse(record.value) : record.value;
  }

  async put(key, value, options = {}) {
    const expiration = options.expiration ?? (options.expirationTtl === undefined
      ? undefined : Math.floor(Date.now() / 1000) + options.expirationTtl);
    await this.storage.put(key, { value, expiration, metadata: options.metadata });
  }

  async delete(key) { await this.storage.delete(key); }

  async list({ prefix = "", limit = 1000, cursor } = {}) {
    const records = await this.storage.list({ prefix, limit, ...(cursor ? { startAfter: cursor } : {}) });
    const entries = [...records.entries()];
    const keys = entries.filter(([, r]) => !r.expiration || r.expiration > Date.now() / 1000)
      .map(([name, r]) => ({ name, expiration: r.expiration, metadata: r.metadata }));
    return { keys, list_complete: entries.length < limit, cursor: entries.at(-1)?.[0] ?? "" };
  }
}
