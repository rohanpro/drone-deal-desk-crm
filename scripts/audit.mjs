// Audit: checks every account against the challenge's five questions and basic data hygiene.
import fs from "node:fs";
import { analyze } from "../src/analyze.mjs";
import { enrich } from "../src/sales.mjs";
const store = JSON.parse(fs.readFileSync(process.argv[2] || "seed/store.json", "utf8"));
const r = enrich(analyze(store, JSON.parse(fs.readFileSync("seed/morning.json", "utf8"))), store);
const issues = [];
const bad = (a, what) => issues.push(`${a}: ${what}`);
const txt = JSON.stringify(r.accounts);
for (const w of ["undefined", "NaN", "[object Object]", "null days", "Unknown (", "→ ask Unknown"]) if (txt.includes(w)) bad("ALL", `text contains "${w}" ×${txt.split(w).length - 1}`);
for (const a of r.accounts) {
  if (a.answers.length !== 5) bad(a.id, "not five answers");
  for (const x of a.answers) if (!x.cites.length) bad(a.id, `answer "${x.q}" has no source`);
  if (!a.moves.length) bad(a.id, "no actions");
  for (const m of a.moves) {
    if (!m.owner?.name || !m.due) bad(a.id, `action without owner/date: ${m.short}`);
    if (!m.cites.length) bad(a.id, `action without source: ${m.short}`);
    if (m.due < r.asOf) bad(a.id, `action due in the past: ${m.short} (${m.due})`);
    const linked = a.risks.filter((x) => x.turns_bad && x.turns_bad >= r.asOf && (x.deals || []).includes(m.deal));
    const firstBad = linked.map((x) => x.turns_bad).sort()[0];
    if (firstBad && m.due > firstBad && m.rank <= 3) bad(a.id, `top action due ${m.due} after its deal turns bad ${firstBad}: ${m.short}`);
    if (!m.how?.steps?.length || m.how.method === "Follow-up") bad(a.id, `no playbook: ${m.short}`);
  }
  for (const x of a.risks) if (!x.cites.length) bad(a.id, `risk without source: ${x.title}`);
  for (const g of a.gaps) if (/^Unknown/.test(g.who)) bad(a.id, `gap with no one to ask: ${g.what}`);
  for (const p of a.pipeline) if (p.kind === "deal" && !p.cites?.length) bad(a.id, `deal without source: ${p.title}`);
  const champs = a.people.filter((p) => p.met && ["warm", "ally"].includes(p.relationship));
  if (!champs.length) bad(a.id, "no warm contact (info)");
  const deciders = a.pipeline.filter((p) => p.kind === "deal" && !p.decider);
  if (deciders.length) bad(a.id, `deals with no decider: ${deciders.map((d) => d.title).join("; ")}`);
  console.log(`${a.id} ${a.short.padEnd(18)} health ${a.healthScore.score} · ${a.answers[0].short} · ${a.moves.length} actions · ${a.risks.filter((x) => x.level === "red").length} red · ${a.gaps.length} gaps · ${a.tickets.filter((t) => t.open).length} open tickets`);
}
let unresolved = [];
const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { if (Array.isArray(x.cites)) x.cites.forEach((c) => { if (!r.evidence[c]) unresolved.push(c); }); Object.values(x).forEach(walk); } };
walk(r.accounts);
if (unresolved.length) bad("ALL", `unresolved sources: ${[...new Set(unresolved)].join(", ")}`);
console.log(issues.length ? "\nISSUES:\n" + issues.map((i) => " - " + i).join("\n") : "\nNo issues.");
