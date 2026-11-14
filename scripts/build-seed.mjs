// Builds seed/store.json from the latest pull (data/pull2 first, then data/) so a fresh deploy renders at once.
import fs from "node:fs";
const pick = (...files) => files.find((f) => fs.existsSync(f));
const map = {
  whoami: ["data/pull2/whoami.json", "data/whoami.json"],
  accounts: ["data/pull2/accounts.json", "data/get_my_accounts.json"],
  signals: ["data/pull2/signals.json", "data/get_signals.json"],
  notes: ["data/pull2/notes.json", "data/list_notes.json"],
  team: ["data/pull2/team.json", "data/get_flytbase_team.json"],
  feature_requests: ["data/pull2/feature_requests.json", "data/get_feature_requests.json"],
  release_notes: ["data/pull2/release_notes.json", "data/get_release_notes.json"],
  schema: ["data/pull2/schema.json", "data/get_data_format.json"],
  paperwork_A: ["data/pull2/paperwork_A.json", "data/get_all_paperwork_A.json"],
  paperwork_B: ["data/pull2/paperwork_B.json", "data/get_all_paperwork_B.json"],
  paperwork_K: ["data/pull2/paperwork_K.json"],
  paperwork_H: ["data/pull2/paperwork_H.json"],
  newacc_K: ["data/pull2/new_account_K.json"],
  newacc_H: ["data/pull2/new_account_H.json"],
  file_flight_log_force_month: ["data/file_flight_log_force_month.json"],
};
for (const f of fs.existsSync("data/pull2") ? fs.readdirSync("data/pull2") : []) { const m = f.match(/^newfile_[A-Z]+_(.+)\.json$/); if (m) map[`file_${m[1]}`] = [`data/pull2/${f}`]; }
const store = { sources: {}, fetchedAt: {}, changes: [], pendingNotes: [], meta: {} };
for (const [k, files] of Object.entries(map)) {
  const p = pick(...files); if (!p) continue;
  store.sources[k] = JSON.parse(fs.readFileSync(p, "utf8"));
  store.fetchedAt[k] = fs.statSync(p).mtime.toISOString();
}
let out = JSON.stringify(store);
for (const id of [store.sources.whoami?.player_id, store.sources.accounts?.player].filter(Boolean)) out = out.split(id).join("redacted");
fs.writeFileSync("seed/store.json", out);
console.log("seed keys:", Object.keys(store.sources).join(", "));
