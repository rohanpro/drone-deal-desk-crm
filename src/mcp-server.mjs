// Our own MCP server (Streamable HTTP, JSON responses) exposing the CRM's answers.
// Point Claude / any MCP client at  POST <host>/mcp
const TOOLS = [
  { name: "crm_overview", description: "Both accounts: health, book you can back, renewal date, top move, red risks.", inputSchema: { type: "object", properties: {} } },
  { name: "account_answers", description: "The five answers for one account (book, power, first moves, risks, gaps), each with source ids.", inputSchema: { type: "object", properties: { account: { type: "string", enum: ["A", "B"] }, question: { type: "string", enum: ["book", "power", "moves", "risks", "gaps", "growth", "all"] } }, required: ["account"] } },
  { name: "trace", description: "Resolve a source id (fact, file, record path, ticket, signal, calc:...) to where it came from and what it says.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "whats_new", description: "Recent changes picked up by the 5-minute sync (new live events, changed facts, stage moves).", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "queue_note", description: "Queue a note/task/risk/next_step to be written back to the Account Quest MCP via write_note.", inputSchema: { type: "object", properties: { account: { type: "string" }, kind: { type: "string", enum: ["note", "task", "risk", "next_step"] }, title: { type: "string" }, text: { type: "string" }, key: { type: "string", description: "WRITE_KEY if the server requires one" } }, required: ["text"] } },
];

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o, null, 1) }] });

export async function mcpHandle(msg, { state, queueNote, writeKey }) {
  if (Array.isArray(msg)) return Promise.all(msg.map((m) => mcpHandle(m, { state, queueNote, writeKey })));
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notification
  if (method === "initialize") return ok(id, { protocolVersion: params.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "drone-deal-desk-crm", version: "1.0.0" } });
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } };
  const s = state();
  const a = (k) => s.accounts.find((x) => x.id === k);
  const args = params.arguments || {};
  switch (params.name) {
    case "crm_overview":
      return ok(id, text({ asOf: s.asOf, accounts: s.accounts.map((x) => ({ id: x.id, name: x.name, health: x.health, book_backed: x.book.backed, at_risk: x.book.at_risk, currency: x.currency, term_ends: x.term_ends, top_move: x.moves[0] && { title: x.moves[0].title, owner: x.moves[0].owner.name, due: x.moves[0].due, cites: x.moves[0].cites }, red_risks: x.risks.filter((r) => r.level === "red").map((r) => ({ title: r.title, turns_bad: r.turns_bad, cites: r.cites })) })) }));
    case "account_answers": {
      const x = a(args.account);
      if (!x) return ok(id, { isError: true, content: [{ type: "text", text: "Unknown account" }] });
      const q = args.question || "all";
      const pick = { book: { backed: x.book.backed, at_risk: x.book.at_risk, deals: x.book.deals.map(({ id, title, stage, backed, at_risk, basis, cites }) => ({ id, title, stage, backed, at_risk, basis: basis.map((b) => s.evidence[b]?.text), cites })), offers: x.book.offers, claims_shown_apart: x.book.claimsApart }, power: x.power, moves: x.moves, risks: x.risks, gaps: x.gaps, growth: x.growth };
      return ok(id, text(q === "all" ? pick : { [q]: pick[q] }));
    }
    case "trace": {
      const e = s.evidence[args.id];
      return ok(id, e ? text(e) : { isError: true, content: [{ type: "text", text: `No source with id ${args.id}` }] });
    }
    case "whats_new":
      return ok(id, text(s.changes.slice(0, args.limit || 20)));
    case "queue_note":
      if (writeKey && args.key !== writeKey) return ok(id, { isError: true, content: [{ type: "text", text: "write key required" }] });
      queueNote({ text: String(args.text), ...(args.account && { account: args.account }), ...(args.kind && { kind: args.kind }), ...(args.title && { title: args.title }) });
      return ok(id, text({ queued: true }));
    default:
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params.name}` } };
  }
}
