import fs from "node:fs";
import { analyze } from "../src/analyze.mjs";
import { enrich } from "../src/sales.mjs";
import { ruleBased } from "../src/assistant.mjs";
const store = JSON.parse(fs.readFileSync("seed/store.json", "utf8"));
const morning = JSON.parse(fs.readFileSync("seed/morning.json", "utf8"));
const r = enrich(analyze(store, morning), store);
for (const a of r.accounts) {
  console.log(`\n### ${a.name} health ${a.healthScore.score} ${a.healthScore.label} lifecycle ${a.lifecycle.stage}`);
  console.log(a.summary);
  a.answers.forEach(x => console.log(" Q:", x.q, "→", x.short));
  console.log(" forecast", a.forecast.commit, a.forecast.bestCase, a.forecast.pipeline);
  a.pipeline.forEach(p => console.log("  deal", p.stageLabel, "|", p.title, "|", p.forecast, p.score ?? "", p.winLabel));
  a.healthScore.parts.forEach(p => console.log("  hp", p.name, p.score, p.why));
  a.moves.forEach(m => console.log("  move", m.rank, m.role, "|", m.short, "| how:", m.how?.method, m.how?.draft ? "draft" : ""));
  console.log("  tickets", a.tickets.filter(t=>t.open).map(t=>`${t.id}:${t.priority}`).join(", "), "activities", a.activities.length);
}
let bad=[]; const walk=(x)=>{ if(Array.isArray(x)) x.forEach(walk); else if(x&&typeof x==="object"){ if(Array.isArray(x.cites)) x.cites.forEach(c=>{ if(!r.evidence[c]) bad.push(c)}); Object.values(x).forEach(walk);} }; walk(r.accounts);
console.log("\nunresolved", [...new Set(bad)]);
console.log("\nRULES:", ruleBased("what do we do first at Aldermoor?", r).text);
