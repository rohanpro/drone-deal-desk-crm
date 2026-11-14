// Flightdeck — revenue cockpit for a drone-in-a-box SaaS team, live over the Account Quest MCP.
//   node server.mjs        (env: AQ_TOKEN, PORT, WRITE_KEY, ANTHROPIC_API_KEY optional)
// Token stays here, never reaches the browser.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// minimal .env loader (local dev only; hosted envs set real env vars)
try {
  for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const { store, startSync, onChange, queueNote } = await import("./src/sync.mjs");
const { analyze } = await import("./src/analyze.mjs");
const { mcpHandle } = await import("./src/mcp-server.mjs");
const { enrich } = await import("./src/sales.mjs");
const { collab, addMessage, setTask, setTicketOwner, publicCollab, onCollab } = await import("./src/collab.mjs");
const { ask, assistantMode } = await import("./src/assistant.mjs");

const morning = JSON.parse(fs.readFileSync("seed/morning.json", "utf8"));
const PORT = Number(process.env.PORT || 8787);
const WRITE_KEY = process.env.WRITE_KEY || "";

let cache = null;
const state = () => (cache ||= enrich(analyze(store, morning), store));
const clients = new Set();

// Auto write-back: when something new lands, write one note per new item to the MCP (deduped).
store.meta.autoNotes ||= {};
function autoNotes() {
  const s = state();
  const existing = new Set((Array.isArray(store.sources.notes) ? store.sources.notes : store.sources.notes?.notes || []).map((n) => n.title));
  const queued = new Set(store.pendingNotes.map((n) => n.title));
  const already = (t) => existing.has(t) || queued.has(t);
  for (const a of s.accounts) {
    const top = a.moves[0];
    const key = `plan:${a.id}:${top?.id}:${top?.due}`;
    if (top && !store.meta.autoNotes[key] && !already(`#1 move: ${top.title}`.slice(0, 120))) {
      store.meta.autoNotes[key] = new Date().toISOString();
      queueNote({ account: a.id, kind: "next_step", title: `#1 move: ${top.title}`.slice(0, 120), text: `${top.why}\nOwner: ${top.owner.name}. Due: ${top.due}. Deal: ${top.deal}. Sources: ${top.cites.join(", ")}` });
    }
    for (const r of a.risks.filter((r) => r.level === "red" && a.signals.some((sid) => r.cites.includes(sid)))) {
      const k = `risk:${r.id}`;
      if (store.meta.autoNotes[k] || already(r.title.slice(0, 120))) continue;
      store.meta.autoNotes[k] = new Date().toISOString();
      queueNote({ account: a.id, kind: "risk", title: r.title.slice(0, 120), text: `${r.detail}\nTurns bad: ${r.turns_bad || "n/a"}. Sources: ${r.cites.join(", ")}` });
    }
  }
}

onChange(() => {
  cache = null;
  const msg = `event: update\ndata: ${JSON.stringify({ at: new Date().toISOString(), changes: store.changes.slice(0, 5) })}\n\n`;
  for (const c of clients) c.write(msg);
});

onCollab((ev) => {
  const msg = `event: collab\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(msg);
});

function slimState() {
  const s = { ...state(), assistant: assistantMode() };
  const evidence = {};
  for (const [k, v] of Object.entries(s.evidence)) evidence[k] = v.text && v.text.length > 1200 ? { ...v, text: v.text.slice(0, 1200), truncated: v.text.length } : v;
  return { ...s, evidence };
}

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok, bad) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") return send(res, 200, fs.readFileSync("public/index.html", "utf8"), "text/html; charset=utf-8");
    if (url.pathname === "/api/state") return send(res, 200, slimState());
    if (url.pathname === "/api/evidence") {
      const e = state().evidence[url.searchParams.get("id")];
      return e ? send(res, 200, e) : send(res, 404, { error: "unknown id" });
    }
    if (url.pathname === "/api/health") return send(res, 200, { ok: true, lastOk: store.meta.lastOk, lastError: store.meta.lastError, nextTick: store.meta.nextTick, fetchedAt: store.fetchedAt, pendingNotes: store.pendingNotes.length });
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`event: hello\ndata: {}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
      req.on("close", () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (url.pathname === "/api/collab") return send(res, 200, publicCollab());
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const b = await readBody(req);
      const m = addMessage({ channel: b.channel, author: b.author, role: b.role, text: b.text, ref: b.ref });
      if (!m) return send(res, 400, { error: "empty message" });
      send(res, 201, m);
      if (b.channel === "ask" || /@flightdeck\b/i.test(m.text)) {
        try {
          const history = collab.messages.filter((x) => x.channel === m.channel).slice(-9, -1);
          const reply = await ask({ question: m.text.replace(/@flightdeck\b/ig, "").trim(), history, state, collab });
          addMessage({ channel: m.channel, author: "Flightdeck", role: reply.source === "claude" ? "AI coach" : "Coach", text: reply.text, ai: true });
        } catch (e) {
          console.error("[assistant]", e);
          addMessage({ channel: m.channel, author: "Flightdeck", role: "Coach", text: "Sorry — I couldn't answer that just now. Try again in a moment.", ai: true });
        }
      }
      return;
    }
    if (url.pathname === "/api/task" && req.method === "POST") {
      const b = await readBody(req);
      const prev = collab.tasks[String(b.id || "")]?.status;
      const t = setTask({ id: String(b.id || ""), status: b.status, by: b.by, role: b.role });
      if (!t) return send(res, 400, { error: "bad task" });
      // Finished work is logged back to Account Quest (one note per action, first time only).
      if (b.status === "done" && prev !== "done" && process.env.AUTO_NOTES !== "0") {
        const a = state().accounts.find((x) => x.moves.some((m) => m.id === b.id));
        const m = a?.moves.find((x) => x.id === b.id);
        if (m) queueNote({ account: a.id, kind: "task", title: `Done: ${m.short}`.slice(0, 150), text: `Marked done by ${t.by || "the team"}${t.role ? ` (${t.role})` : ""} in Flightdeck on ${t.at.slice(0, 10)}.\n${m.why}\nSources: ${m.cites.join(", ")}` });
      }
      return send(res, 200, t);
    }
    if (url.pathname === "/api/ticket" && req.method === "POST") {
      const b = await readBody(req);
      const t = setTicketOwner({ id: b.id, owner: b.owner, role: b.role });
      return t ? send(res, 200, t) : send(res, 400, { error: "bad ticket" });
    }
    if (url.pathname === "/brand.svg") return send(res, 200, fs.readFileSync("public/brand.svg", "utf8"), "image/svg+xml");
    if (url.pathname === "/api/notes" && req.method === "POST") {
      const b = await readBody(req);
      if (WRITE_KEY && b.key !== WRITE_KEY) return send(res, 403, { error: "write key required" });
      if (!b.text || String(b.text).length > 4000) return send(res, 400, { error: "text required (max 4000 chars)" });
      const note = { text: String(b.text), ...(b.account && { account: String(b.account) }), ...(b.kind && { kind: String(b.kind) }), ...(b.title && { title: String(b.title).slice(0, 160) }) };
      queueNote(note);
      return send(res, 202, { queued: true, position: store.pendingNotes.length, note });
    }
    if (url.pathname === "/mcp") {
      if (req.method === "GET") return send(res, 405, { error: "POST JSON-RPC here" });
      const b = await readBody(req);
      const out = await mcpHandle(b, { state, queueNote, writeKey: WRITE_KEY });
      return out === null ? (res.writeHead(202), res.end()) : send(res, 200, out);
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`CRM on http://localhost:${PORT}  (MCP endpoint: /mcp)`);
  startSync();
  if (process.env.AUTO_NOTES !== "0") setTimeout(autoNotes, 5000);
  setInterval(() => process.env.AUTO_NOTES !== "0" && autoNotes(), 5 * 60_000);
});
