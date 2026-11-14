// Builds seed/store.json from the one-off pull in data/ so a fresh deploy has data before its first sync.
import fs from "node:fs";
const map = { whoami: "whoami", accounts: "get_my_accounts", paperwork_A: "get_all_paperwork_A", paperwork_B: "get_all_paperwork_B", signals: "get_signals", notes: "list_notes", team: "get_flytbase_team", feature_requests: "get_feature_requests", release_notes: "get_release_notes", schema: "get_data_format", file_flight_log_force_month: "file_flight_log_force_month" };
const store = { sources: {}, fetchedAt: {}, changes: [], pendingNotes: [], meta: {} };
for (const [k, f] of Object.entries(map)) {
  const p = `data/${f}.json`;
  if (!fs.existsSync(p)) continue;
  store.sources[k] = JSON.parse(fs.readFileSync(p, "utf8"));
  store.fetchedAt[k] = fs.statSync(p).mtime.toISOString();
}
// never ship the player id (it is the first half of the token)
let out = JSON.stringify(store);
for (const id of [store.sources.whoami?.player_id, store.sources.accounts?.player].filter(Boolean)) out = out.split(id).join("redacted");
fs.writeFileSync("seed/store.json", out);
console.log("seed keys:", Object.keys(store.sources).join(", "));
