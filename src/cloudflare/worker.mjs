/**
 * Qwen 125B MCP edge gateway, step 6: transport staging ONLY.
 *
 * SECURITY INVARIANT: until the verified ChatGPT OAuth authorizer is
 * implemented in roadmap step 7, every /mcp request fails closed.
 * VPC binding is configured at deployment, but no caller can reach it.
 * Do not enable upstream forwarding by merely setting an environment flag.
 */
const HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, ...extraHeaders },
  });
}

export default {
  async fetch(request, _env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/__edge_status") {
      return json(200, { state: "locked", endpoint: "mcp" });
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // No Authorization header, cookie, or caller-supplied claim is accepted.
      // A real OAuth decision + device-bound origin credentials are stage 7/8.
      return json(401, { error: "authorization_not_configured" }, {
        "www-authenticate": 'Bearer realm="qwen125b-mcp"',
      });
    }

    return json(404, { error: "not_found" });
  },
};
