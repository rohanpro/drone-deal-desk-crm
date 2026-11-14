// Initial pull: one MCP call per ~62s (rate limit = 1/min/token). Saves each result to data/<name>.json
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n").filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)));
const MCP = "https://questathon.aihackerscollective.com/api/public/mcp";
async function call(name, args = {}) {
  const res = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${env.AQ_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }) });
  const txt = await res.text();
  let body = txt; if (txt.startsWith("event:") || txt.includes("\ndata:")) body = txt.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).join("");
  const j = JSON.parse(body);
  if (j.error || j.result?.isError) throw new Error(JSON.stringify(j.error ?? j.result.content));
  const t = j.result.content[0].text; try { return JSON.parse(t); } catch { return t; }
}
const jobs = process.argv.slice(2).map(s => { const i = s.indexOf(":"); return i < 0 ? [s, {}] : [s.slice(0, i), JSON.parse(s.slice(i + 1))]; });
for (let i = 0; i < jobs.length; i++) {
  const [n, a] = jobs[i]; const file = `data/${n}${a.account ? "_" + a.account : ""}.json`;
  try { const r = await call(n, a); fs.writeFileSync(file, JSON.stringify(r, null, 2)); console.log(new Date().toISOString(), "OK", file, JSON.stringify(r).length); }
  catch (e) { console.log(new Date().toISOString(), "FAIL", n, e.message); }
  if (i < jobs.length - 1) await new Promise(r => setTimeout(r, 62000));
}
console.log("DONE");
