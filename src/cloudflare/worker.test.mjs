import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.mjs";

const target = "https://qwen125b-mcp.vl-ktk.workers.dev";
function environment() {
  let calls = 0;
  return {
    get calls() { return calls; },
    QWEN_MCP_ORIGIN: {
      async fetch() { calls++; throw new Error("INSECURE UPSTREAM FORWARD"); },
    },
  };
}

test("status endpoint is non-sensitive and clearly locked", async () => {
  const env = environment();
  const response = await worker.fetch(new Request(target + "/__edge_status"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: "locked", endpoint: "mcp" });
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(env.calls, 0);
});

for (const method of ["GET", "POST", "DELETE", "PUT"]) {
  test("MCP " + method + " fails closed even with forged bearer", async () => {
    const env = environment();
    const init = { method, headers: {
      authorization: "Bearer attacker-supplied",
      "cf-access-jwt-assertion": "forged",
      "mcp-session-id": "forged-session",
    }};
    if (method === "POST" || method === "PUT") init.body = "{}";
    const response = await worker.fetch(new Request(target + "/mcp", init), env);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "authorization_not_configured");
    assert.equal(env.calls, 0);
  });
}

test("nested MCP URL also fails closed", async () => {
  const env = environment();
  const response = await worker.fetch(new Request(target + "/mcp/tools/call"), env);
  assert.equal(response.status, 401);
  assert.equal(env.calls, 0);
});

test("all other routes fail with 404 and no upstream call", async () => {
  const env = environment();
  const response = await worker.fetch(new Request(target + "/admin"), env);
  assert.equal(response.status, 404);
  assert.equal(env.calls, 0);
});

test("status never reveals internal VPC binding or tunnel details", async () => {
  const response = await worker.fetch(new Request(target + "/__edge_status"), environment());
  const body = await response.text();
  assert.equal(body.includes("127.0.0.1"), false);
  assert.equal(body.includes("b49f90d5"), false);
  assert.equal(body.includes("01a1f103"), false);
});
