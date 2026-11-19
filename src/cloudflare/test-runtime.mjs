// Test-only Durable Object. Never referenced by wrangler.json or production code.
export { default } from "./worker.mjs";
import { QwenOAuthState } from "./worker.mjs";
export class TestOAuthState extends QwenOAuthState {
  async expire(prefix, field) {
    for (const [key, record] of await this.ctx.storage.list({ prefix })) {
      if (field) {
        const value = JSON.parse(record.value);
        value[field] = 1;
        record.value = JSON.stringify(value);
      } else record.expiration = 1;
      await this.ctx.storage.put(key, record);
    }
  }
  async failStorage() { await this.ctx.storage.deleteAll(); }
  async bumpGeneration() { this.env.QWEN_OAUTH_GENERATION = "2"; }
  async audit() { return this.ctx.storage.sql.exec("SELECT path, status, stage, reason FROM qwen_oauth_audit_v1 ORDER BY at_ms").toArray(); }
}
