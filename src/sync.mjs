// Sync engine: keeps a local store of everything the Account Quest MCP exposes.
// Rate limit is 1 call / minute / token, so ALL calls go through one queue ticking every 62s.
//  - Bootstrap: fetch each static thing once (accounts, paperwork, files, team, schema...)
//  - Steady state: a 5-slot rotation => every source refreshed at least every 5 minutes,
//    live signals every ~2.5 minutes.
//  - Writes (write_note) jump the queue.
//  - Every refresh is diffed against the previous copy; differences go to a change log.
import fs from "node:fs";
import path from "node:path";
import { callTool } from "./mcp-client.mjs";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const SEED_DIR = path.resolve("seed");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const TICK_MS = Number(process.env.TICK_MS || 62_000);

fs.mkdirSync(DATA_DIR, { recursive: true });

export const store = load();
const listeners = new Set();
export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));

function load() {
  for (const f of [STORE_FILE, path.join(SEED_DIR, "store.json")]) {
    try {
      const s = JSON.parse(fs.readFileSync(f, "utf8"));
      s.meta = { ...(s.meta || {}), loadedFrom: path.basename(path.dirname(f)) };
      return s;
    } catch {}
  }
  return { sources: {}, fetchedAt: {}, changes: [], pendingNotes: [], meta: {} };
}
function save() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 1));
  for (const fn of listeners) try { fn(store); } catch {}
}

// key -> [tool, args]
const SOURCES = {
  whoami: ["whoami", {}],
  accounts: ["get_my_accounts", {}],
  paperwork_A: ["get_all_paperwork", { account: "A" }],
  paperwork_B: ["get_all_paperwork", { account: "B" }],
  signals: ["get_signals", {}],
  notes: ["list_notes", {}],
  team: ["get_flytbase_team", {}],
  feature_requests: ["get_feature_requests", {}],
  release_notes: ["get_release_notes", {}],
  schema: ["get_data_format", {}],
};
const ROTATION = ["signals", "accounts", "signals", "paperwork_A", "whoami", "signals", "notes", "signals", "paperwork_B", "accounts"];
let rot = 0;
const queue = []; // explicit priority jobs: {key, tool, args} or {write: noteArgs}

function nextJob() {
  if (store.pendingNotes.length) return { write: store.pendingNotes[0] };
  if (queue.length) return queue.shift();
  // bootstrap anything never fetched
  for (const k of Object.keys(SOURCES)) if (!store.sources[k]) return { key: k };
  for (const f of store.sources.accounts?.files || []) if (!store.sources[`file_${f.id}`]) return { key: `file_${f.id}`, tool: "get_file", args: { id: f.id } };
  const k = ROTATION[rot++ % ROTATION.length];
  return { key: k };
}

async function tick() {
  const job = nextJob();
  const started = new Date().toISOString();
  try {
    if (job.write) {
      const r = await callTool("write_note", job.write);
      store.pendingNotes.shift();
      logChange("note_written", `Note written back to MCP: ${job.write.title || job.write.text.slice(0, 60)}`, { result: r });
      queue.push({ key: "notes" });
    } else {
      const [tool, args] = job.tool ? [job.tool, job.args] : SOURCES[job.key];
      const data = await callTool(tool, args);
      const prev = store.sources[job.key];
      store.sources[job.key] = data;
      store.fetchedAt[job.key] = started;
      if (prev !== undefined) diff(job.key, prev, data);
      // whoami tells us when something new is open -> refresh the rest sooner
      if (job.key === "whoami" && prev) {
        if ((data.signals ?? 0) !== (prev.signals ?? 0)) queue.push({ key: "signals" }, { key: "accounts" });
        if (JSON.stringify(data.new_accounts) !== JSON.stringify(prev.new_accounts)) queue.push({ key: "accounts" });
      }
    }
    store.meta.lastOk = started;
    store.meta.lastError = null;
  } catch (e) {
    store.meta.lastError = { at: started, job: job.key || "write_note", message: String(e.message || e).slice(0, 300) };
    console.error("[sync]", job.key || "write", e.message);
  }
  store.meta.lastTick = started;
  store.meta.nextTick = new Date(Date.now() + TICK_MS).toISOString();
  save();
}

function logChange(kind, summary, extra = {}) {
  store.changes.unshift({ at: new Date().toISOString(), kind, summary, ...extra });
  store.changes = store.changes.slice(0, 300);
}

// Domain-aware diff so the UI can say exactly what is new.
function diff(key, prev, next) {
  if (JSON.stringify(prev) === JSON.stringify(next)) return;
  if (key === "signals") {
    const ids = new Set(listOf(prev).map(sigKey));
    for (const s of listOf(next)) if (!ids.has(sigKey(s))) logChange("new_signal", `Live event: ${s.title || s.headline || s.text || sigKey(s)}`, { source: "get_signals", ref: sigKey(s), account: s.account });
    return;
  }
  if (key === "accounts") {
    for (const acc of next.accounts || []) {
      const old = (prev.accounts || []).find((a) => a.id === acc.id);
      if (!old) { logChange("new_account", `New account: ${acc.name}`, { source: "get_my_accounts", account: acc.id }); continue; }
      for (const coll of ["stakeholders", "facts", "opportunities", "offers", "deadlines"]) {
        const om = new Map((old[coll] || []).map((x) => [x.id ?? JSON.stringify(x), x]));
        for (const x of acc[coll] || []) {
          const id = x.id ?? JSON.stringify(x);
          const o = om.get(id);
          if (!o) logChange(`new_${coll}`, `${acc.id}: new ${coll.replace(/s$/, "")} ${x.id || ""} — ${x.title || x.text || x.name || ""}`.trim(), { source: "get_my_accounts", ref: x.id, account: acc.id });
          else if (JSON.stringify(o) !== JSON.stringify(x)) {
            const fields = Object.keys({ ...o, ...x }).filter((f) => JSON.stringify(o[f]) !== JSON.stringify(x[f]));
            logChange(`changed_${coll}`, `${acc.id}: ${x.id || x.name} changed (${fields.join(", ")})`, { source: "get_my_accounts", ref: x.id, account: acc.id, before: pick(o, fields), after: pick(x, fields) });
          }
        }
      }
    }
    return;
  }
  logChange("source_changed", `${key} changed`, { source: SOURCES[key]?.[0] || key });
}
const listOf = (x) => (Array.isArray(x) ? x : x?.signals || x?.events || x?.items || []);
const sigKey = (s) => s.id || `${s.account}|${s.at || s.date || s.day}|${s.title || s.headline}`;
const pick = (o, f) => Object.fromEntries(f.map((k) => [k, o[k]]));

export function queueNote(note) {
  store.pendingNotes.push(note);
  save();
}
export function refreshNow(key) {
  if (SOURCES[key]) queue.unshift({ key });
}

let timer;
export function startSync() {
  if (timer) return;
  if (!process.env.AQ_TOKEN) { console.warn("[sync] AQ_TOKEN missing — serving stored data only"); return; }
  setTimeout(tick, 2_000);
  timer = setInterval(tick, TICK_MS);
}
