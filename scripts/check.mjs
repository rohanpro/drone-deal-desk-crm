import fs from "node:fs";
import { analyze } from "../src/analyze.mjs";
const store = JSON.parse(fs.readFileSync("seed/store.json", "utf8"));
const morning = JSON.parse(fs.readFileSync("seed/morning.json", "utf8"));
const r = analyze(store, morning);
console.log("asOf", r.asOf, "evidence ids", Object.keys(r.evidence).length);
for (const a of r.accounts) {
  console.log(`\n### ${a.id} ${a.name} ${a.health.label} renewal in ${a.days_to_renewal}d`);
  console.log("BOOK backed", a.book.backed, "at risk", a.book.at_risk, "open offers", a.book.open_offers);
  for (const d of a.book.deals) console.log("  deal", d.id, d.stage, d.backed, d.at_risk, d.basis.map(b => r.evidence[b].text).join(" | "));
  console.log("POWER"); for (const p of a.power) console.log("  ", p.deal, p.roles.map(x => `${x.role}:${x.who}(${x.stance})`).join("; "));
  console.log("MOVES"); for (const m of a.moves) console.log(`  #${m.rank} [${m.score}] ${m.due} ${m.owner.name} :: ${m.title}`);
  console.log("RISKS"); for (const x of a.risks) console.log(`  ${x.level} ${x.turns_bad} :: ${x.title}`);
  console.log("GAPS"); for (const g of a.gaps) console.log(`  ${g.what} -> ${g.who}`);
  if (a.forceLog) { console.log("FORCE", JSON.stringify(a.forceLog.summary.map(f => [f.force, f.docks, f.live_missions, f.operational]))); a.forceLog.issues.forEach(i => console.log("  dq", i.line, i.issue)); }
}
// citation integrity: every cite must resolve
let bad = [];
const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { if (Array.isArray(x.cites)) x.cites.forEach(c => { if (!r.evidence[c]) bad.push(c); }); Object.values(x).forEach(walk); } };
walk(r.accounts);
console.log("\nunresolved cites:", [...new Set(bad)]);
