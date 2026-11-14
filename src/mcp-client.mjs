// Thin client for the Account Quest MCP (JSON-RPC over HTTP).
// The token lives only on the server (env AQ_TOKEN). Never sent to the browser.
export const MCP_URL = process.env.AQ_MCP_URL || "https://questathon.aihackerscollective.com/api/public/mcp";

export async function callTool(name, args = {}) {
  const token = process.env.AQ_TOKEN;
  if (!token) throw new Error("AQ_TOKEN is not set");
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
  });
  const txt = await res.text();
  let body = txt;
  if (txt.startsWith("event:") || txt.includes("\ndata:")) {
    body = txt.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
  }
  let j;
  try { j = JSON.parse(body); } catch { throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`); }
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  if (j.result?.isError) throw new Error(j.result.content?.[0]?.text || "tool error");
  const t = j.result.content[0].text;
  try { return JSON.parse(t); } catch { return t; }
}
