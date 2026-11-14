// Re-pull everything (incl. new accounts) with retry when the shared 1-call/min limit is hit.
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const MCP = "https://questathon.aihackerscollective.com/api/public/mcp";
const OUT = "data/pull2";
async function call(name, args = {}) {
  const res = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${env.AQ_TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }) });
  const txt = await res.text();
  const body = txt.includes("data:") ? txt.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("") : txt;
  const j = JSON.parse(body);
  if (j.error || j.result?.isError) throw new Error(JSON.stringify(j.error ?? j.result.content).slice(0, 300));
  const t = j.result.content[0].text; try { return JSON.parse(t); } catch { return t; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(name, args, file) {
  for (let i = 0; i < 8; i++) {
    try { const r = await call(name, args); fs.writeFileSync(`${OUT}/${file}.json`, JSON.stringify(r, null, 1)); console.log(new Date().toISOString(), "OK", file, JSON.stringify(r).length); await wait(62000); return r; }
    catch (e) { console.log(new Date().toISOString(), "RETRY", file, e.message.slice(0, 120)); await wait(/rate|limit|minute|429/i.test(e.message) ? 35000 : 62000); }
  }
  console.log("FAIL", file);
}
const who = await get("whoami", {}, "whoami");
const ids = (who?.new_accounts || []).map((a) => (typeof a === "string" ? a : a.id || a.account)).filter(Boolean);
const newIds = ids.length ? ids : ["K", "H"];
const newAcc = {};
for (const id of newIds) newAcc[id] = await get("get_new_account", { account: id }, `new_account_${id}`);
for (const id of newIds) await get("get_all_paperwork", { account: id }, `paperwork_${id}`);
await get("get_signals", {}, "signals");
await get("get_my_accounts", {}, "accounts");
for (const id of newIds) for (const f of newAcc[id]?.files || newAcc[id]?.accounts?.[0]?.files || []) await get("get_new_account_file", { account: id, file_id: f.id }, `newfile_${id}_${f.id}`);
await get("get_all_paperwork", { account: "B" }, "paperwork_B");
await get("get_all_paperwork", { account: "A" }, "paperwork_A");
await get("list_notes", {}, "notes");
await get("get_feature_requests", {}, "feature_requests");
await get("get_flytbase_team", {}, "team");
await get("get_release_notes", {}, "release_notes");
await get("get_data_format", {}, "schema");
console.log("DONE");
