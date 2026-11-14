// Sales-cycle layer on top of the decision engine (src/analyze.mjs).
// Adds the things a B2B team works with every day, in plain English:
// pipeline stages, MEDDPICC, forecast categories, health score, lifecycle,
// tickets, an activity timeline with attachments, plays ("how to do it")
// with ready drafts, and role ownership. Every item keeps its source ids.
import { parseCSV, days, fmtDate } from "./parse.mjs";

export const STAGES = [
  { key: "prospect", label: "Prospect", hint: "We think a deal exists but nobody has said so." },
  { key: "discover", label: "Discover", hint: "The customer has named the need." },
  { key: "qualify", label: "Qualify", hint: "We know the value and what blocks it." },
  { key: "prove", label: "Prove value", hint: "Evidence in front of the decision maker." },
  { key: "propose", label: "Proposal", hint: "Priced proposal or quote with the buyer." },
  { key: "commit", label: "Commit", hint: "Verbal yes; paperwork in motion." },
  { key: "won", label: "Won", hint: "Signed or delivered." },
  { key: "lost", label: "Lost", hint: "Declined." },
];
const STAGE_FROM_DATA = { identified: "discover", qualified: "qualify", cleared: "propose", agreed: "commit", current: "prove" };

export const LIFECYCLE = ["Onboard", "Adopt", "Expand", "Renew"];

export const ROLES = {
  "You (CSM)": "Customer Success",
  "Achal Negi": "Account Executive",
  "Pranjal Suyal": "Solutions Engineer",
  "Neel Sharma": "Sales Manager",
  "Yashash Rao": "Marketing / GTM",
  "Support desk": "Support",
  SRV: "Engineering",
};
export const ROLE_LIST = ["Customer Success", "Account Executive", "Solutions Engineer", "Sales Manager", "Support", "Marketing / GTM"];

const shortDate = (d) => (d ? new Date(d.length === 10 ? d + "T00:00:00Z" : d).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "");

/** Human label for any evidence id: what a salesperson would call it. */
export function humanSource(e) {
  if (!e) return "Source";
  const p = e.label || "";
  switch (e.kind) {
    case "fact": return `${e.said_by || "Someone"} said${e.status === "verified" ? " · verified" : e.status === "claim" ? " · unverified claim" : ""}`;
    case "file": return `File: ${p}`;
    case "signal": return `Live alert · ${shortDate(e.date)}`;
    case "debrief": return "Morning discovery notes";
    case "team": return p.split(" — ")[0];
    case "person": return p.split(" — ")[0];
    case "deal": return `Deal: ${p}`;
    case "offer": return `Offer: ${p.replace(/ \((won|open|declined)\)$/, "")}`;
    case "ticket": return `Ticket ${e.id}`;
    case "calc": return "How we worked it out";
    case "risk": return "Risk";
    case "move": return "Action";
    case "activity": return e.human || "Record";
    case "record": {
      const m = p.match(/(\d{4}-\d{2}-\d{2})_?(.*)\.txt$/);
      if (p.startsWith("calls/") && m) return `Call notes · ${shortDate(m[1])}`;
      if (p.startsWith("emails/") && m) return `Email · ${shortDate(m[1])}`;
      const names = { "contract.txt": "Contract", "flights.csv": "Flight records", "device_events.csv": "Dock health log", "devices.json": "Dock list", "usage_weekly.csv": "Weekly usage", "requests.csv": "Request log", "tickets.json": "Support tickets", "profile.json": "Account profile", "users.json": "Platform logins", "invoices.json": "Invoices", "mail_log.json": "Email log", "calls_index.json": "Call log", "deal_history.json": "Deal history", "internal_notes.json": "Internal notes" };
      return names[p] || p;
    }
    default: return p || "Source";
  }
}

export function enrich(r, store) {
  const S = store.sources || {};
  const E = r.evidence;
  for (const [id, e] of Object.entries(E)) e.human = humanSource(e);

  for (const a of r.accounts) {
    // plain-English titles for "nobody replied" risks
    for (const x of a.risks.filter((x) => x.type === "Unanswered")) {
      const m = x.title.match(/^(?:(FB-\d+) — )?([^:]+): (.*)$/);
      if (!m) continue;
      const from = m[2].replace(/\s*\(.*?\)/g, "").replace(/^A contact at/, "a contact at").replace(/^Insp\. /, "");
      const wait = x.detail.match(/Open (\d+) days/)?.[1];
      x.title = `No reply${wait ? ` for ${wait} days` : ""}: ${m[3].replace(/^Asked (for |whether )?/i, "").replace(/^Email about /i, "")} — ${from}${m[1] ? ` (${m[1]})` : ""}`;
    }
    const pw = Object.fromEntries((S[`paperwork_${a.id}`]?.records || []).map((x) => [x.path, x]));
    const data = (p) => pw[p]?.data;
    const money = (n) => (n == null ? "—" : `${a.symbol}${Math.round(n).toLocaleString("en-GB")}`);
    const k = (n) => (n == null ? "—" : n >= 1e6 ? `${a.symbol}${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${a.symbol}${Math.round(n / 1e3)}k` : money(n));
    a.k = k;
    const person = (name) => a.people.find((p) => p.name === name || (name && p.name.endsWith(name)));
    const renewal = a.book.deals.find((d) => /renew/i.test(d.title) || d.synthetic);

    // ---------- deals: stage, MEDDPICC, forecast ----------
    const pipeline = [];
    for (const d of a.book.deals) {
      const db = d.debrief;
      const stage = d.unknown ? "prospect" : STAGE_FROM_DATA[d.stage] || "discover";
      const ev = (d.evidence || []).map((id) => E[id]).filter(Boolean);
      const verified = ev.some((e) => e.status === "verified") || d.basis.length > 0;
      const told = ev.some((e) => e.status === "told");
      const roles = a.power.find((p) => p.deal === d.id)?.roles || [];
      const champ = roles.find((x) => /champion/i.test(x.role) || (x.role === "Uses" && ["warm", "ally"].includes(x.stance)));
      const payerName = db?.pays || roles.find((x) => /pays|decides/i.test(x.role) && x.name)?.name || null;
      const eb = payerName ? person(payerName) : null;
      const accSig = a.signals.map((id) => E[id]).filter(Boolean);
      const leavingNames = accSig.filter((sg) => /moving on|leaves|leaving/i.test(sg.label + " " + sg.text)).map((sg) => sg.text);
      const leaving = (n) => !!n && leavingNames.some((t) => t.includes(n.split(" ").pop()));
      const facts = (re) => a.facts.filter((f) => re.test(f.text));
      const procF = facts(/\b(signs?|vote|approv|budget|call-off|board|finance)\b/i);
      const contract = E[`${a.id}/contract.txt`]?.text || "";
      const signedBy = contract.match(/Signed:[^\n]*?by ([^\n,]+)/i)?.[1] || contract.match(/ordered through ([^\n,]+)/i)?.[1];
      const isRenewal = /renew/i.test(d.title) || d.synthetic;
      const sq = facts(/helicopter|guard|patrol hours|officer|staff time/i)[0];
      const m = [
        { k: "M", name: "Metrics", q: "Can we prove the value in numbers?", s: verified ? "green" : told ? "amber" : "red", note: verified ? "Usage numbers on file back it." : told ? "Only what people told us — no file yet." : "No numbers yet.", fix: "Pull usage by site and put it next to the price.", cites: d.basis.length ? d.basis.slice(0, 1) : (d.evidence || []).slice(0, 2) },
        { k: "E", name: "Economic buyer", q: "Who signs off the money, and have we met them?", s: !eb ? "red" : !eb.met ? "red" : ["warm", "ally"].includes(eb.relationship) ? "green" : "amber", note: payerName ? `${payerName}${eb && !eb.met ? " — never met" : eb ? ` — ${eb.relationship}` : ""}${leaving(payerName) ? " — leaving" : ""}` : "Not known.", fix: payerName ? `Get time with ${payerName}.` : "Ask the champion who signs.", cites: db ? [db.id] : roles.filter((x) => /pays|decides/i.test(x.role)).flatMap((x) => x.cites).slice(0, 2) },
        { k: "D", name: "Decision criteria", q: "What must be true for them to say yes?", s: d.blocker?.status === "cleared" ? "green" : db?.blocker || d.blocker ? "amber" : "red", note: db?.blocker || d.blocker?.text || "Unknown.", fix: db?.blocker || d.blocker ? `Answer it: ${db?.blocker || d.blocker.text}` : "Ask what a yes depends on.", cites: [db?.id, d.blocker && !d.synthetic ? d.id : null].filter(Boolean) },
        { k: "D", name: "Decision process", q: "What steps and who, in what order?", s: procF.length ? "amber" : isRenewal ? "amber" : "red", note: procF[0]?.text || (isRenewal ? "New order needed before term ends; no auto-renew." : "Unknown."), fix: "Write the steps down with the customer (mutual action plan).", cites: procF.length ? procF.slice(0, 2).map((f) => f.id) : isRenewal ? [`${a.id}/contract.txt`] : [] },
        { k: "P", name: "Paper process", q: "How does the paperwork get signed?", s: isRenewal ? "amber" : "red", note: isRenewal ? `Last order ${signedBy ? `signed by ${signedBy.trim()}` : "on file"}; this time is unconfirmed.` : "Unknown.", fix: "Ask finance or procurement for the order route and lead time.", cites: isRenewal ? [`${a.id}/contract.txt`] : [] },
        { k: "I", name: "Identified pain", q: "What problem hurts enough to act on?", s: told || verified ? "green" : "red", note: ev.find((e) => e.kind === "fact")?.label?.slice(0, 120) || "Not heard yet.", fix: "Ask: what happens if this doesn't get solved?", cites: (d.evidence || []).filter((id) => E[id]?.kind === "fact").slice(0, 2) },
        { k: "C", name: "Champion", q: "Who sells this for us when we're not in the room?", s: champ ? (leaving(champ.who) ? "amber" : "green") : "red", note: champ ? `${champ.who} (${champ.stance})${leaving(champ.who) ? " — leaving" : ""}` : "Nobody yet.", fix: champ ? "Give them the evidence to carry." : "Find someone who gains from it.", cites: champ?.cites?.slice(0, 1) || [] },
        { k: "C", name: "Competition", q: "What else could they do instead?", s: "amber", note: sq ? `Status quo: ${sq.text.slice(0, 110)}` : "Status quo: do nothing and keep the people they have.", fix: "Price us against the status quo, per flight or per night.", cites: sq ? [sq.id] : [] },
      ].map((x) => ({ ...x, cites: x.cites.filter((c) => E[c]) }));
      const score = Math.round((100 * m.reduce((s, x) => s + (x.s === "green" ? 2 : x.s === "amber" ? 1 : 0), 0)) / (m.length * 2));
      const value = d.contracted || d.worth_up_to || null;
      const advanced = ["qualify", "prove", "propose", "commit"].includes(stage);
      const forecast = d.unknown ? "Omitted" : d.backed && advanced && score >= 50 ? "Commit" : d.backed || value ? "Best case" : "Pipeline";
      const next = STAGES[STAGES.findIndex((s) => s.key === stage) + 1];
      const exit = m.filter((x) => x.s !== "green").slice(0, 3).map((x) => x.fix);
      const lastTouch = a.timelineLast;
      pipeline.push({
        id: d.id, kind: "deal", title: d.title, stage, stageLabel: STAGES.find((s) => s.key === stage).label, next: next?.label, exit,
        value, valueText: value ? money(value) : d.debrief?.debrief_value_usd ? "Not sized yet" : "Not sized yet",
        backed: d.backed || 0, atRisk: d.at_risk || 0, meddpicc: m, score, forecast,
        winLabel: score >= 65 ? "Strong" : score >= 40 ? "Fair" : "Weak",
        blocker: db?.blocker || d.blocker?.text || null, decider: db?.decides || roles.find((x) => /decides/i.test(x.role) && x.name)?.name || payerName, deciderCites: db ? [db.id] : roles.filter((x) => /decides|pays/i.test(x.role)).flatMap((x) => x.cites).slice(0, 2), synthetic: !!d.synthetic, unknown: !!d.unknown,
        closeBy: /renew/i.test(d.title) ? a.term_ends : null, cites: d.cites,
      });
    }
    for (const o of a.book.offers) pipeline.push({ id: o.id, kind: "offer", title: o.title, stage: o.status === "won" ? "won" : o.status === "declined" ? "lost" : "propose", stageLabel: o.status === "won" ? "Won" : o.status === "declined" ? "Lost" : "Proposal", value: o.value, valueText: money(o.value), forecast: o.status === "won" ? "Won" : o.status === "open" ? "Best case" : "Lost", winLabel: o.status === "won" ? "Won" : o.status === "open" ? "Open" : "Lost", decider: o.pitch_to, cites: o.cites, upsell: true });
    a.pipeline = pipeline;

    // ---------- forecast ----------
    const won = a.book.offers.filter((o) => o.status === "won").reduce((s, o) => s + o.value, 0);
    const cat = { Commit: 0, "Best case": 0, Won: won, Pipeline: 0 };
    for (const p of pipeline.filter((x) => x.kind === "deal")) {
      if (p.forecast === "Commit") { cat.Commit += p.backed; cat["Best case"] += p.atRisk; }
      else if (p.forecast === "Best case") cat["Best case"] += p.value || 0;
    }
    cat["Best case"] += a.book.open_offers;
    a.forecastCats = cat;
    a.forecast = {
      commit: (renewal?.backed || 0) + won, commitWhy: `Renewal on docks that fly (${money(renewal?.backed)}) + upsells already won (${money(won)})`,
      bestCase: (renewal?.at_risk || 0) + a.book.open_offers, bestWhy: `Docks nobody flies (${money(renewal?.at_risk)}) + open offers (${money(a.book.open_offers)}) — needs work to land`,
      pipeline: pipeline.filter((p) => p.forecast === "Pipeline").length, pipelineWhy: "Expansion deals with no price yet",
      unverified: a.book.claimsApart.filter((c) => c.implied).reduce((s, c) => s + c.implied, 0),
      cites: [a.book.backedCalc, renewal?.basis?.[1]].filter(Boolean),
    };

    // ---------- health score ----------
    const ops = a.forceLog ? a.forceLog.summary.filter((f) => f.operational).reduce((s, f) => s + f.docks, 0) : a.usage.tiers.regular.length;
    const adoption = Math.round((100 * ops) / Math.max(1, a.usage.totalDocks));
    const met = a.people.filter((p) => p.met);
    const warm = met.filter((p) => ["warm", "ally"].includes(p.relationship)).length;
    const leaving = (r.evidence.champion_leaves?.account === a.id);
    const payerGuarded = pipeline.some((p) => p.kind === "deal" && p.decider && person(p.decider)?.relationship === "guarded");
    const coldReds = a.risks.filter((x) => x.type === "Going cold" && x.level === "red").length;
    const relationships = Math.max(0, Math.min(100, warm * 35 + (met.length - warm) * 10) - (leaving ? 25 : 0) - (payerGuarded ? 30 : 0) - coldReds * 15);
    const deciders = [...new Set(pipeline.filter((p) => p.kind === "deal").map((p) => p.decider).filter(Boolean))];
    const access = deciders.length ? Math.round((100 * deciders.filter((n) => person(n)?.met).length) / deciders.length) : 50;
    const openNoOwner = a.risks.filter((x) => x.type === "Unanswered").length;
    const support = Math.max(0, 100 - a.risks.filter((x) => x.type === "Unanswered").reduce((t, x) => t + 22 + (/for (\d{3,}) days/.test(x.title) ? 20 : 0), 0));
    const reds = a.risks.filter((x) => x.level === "red").length;
    const momentum = Math.max(0, 100 - reds * 15);
    const parts = [
      { name: "Product use", score: adoption, why: a.forceLog ? `${ops} of ${a.usage.totalDocks} docks are at ${a.forceLog.unitWord || "forces"} that fly live missions` : `${ops} of ${a.usage.totalDocks} docks fly regularly`, cites: [a.forceLog?.file || `calc:${a.id}:tiers`] },
      { name: "Relationships", score: relationships, why: `${warm} warm, ${met.length - warm} neutral or guarded${leaving ? "; main contact is leaving" : ""}${payerGuarded ? "; the person who pays is guarded" : ""}${coldReds ? `; ${coldReds} contact(s) gone cold` : ""}`, cites: met.map((p) => p.id).slice(0, 3).concat(leaving ? ["champion_leaves"] : []) },
      { name: "Access to decision makers", score: access, why: `${deciders.filter((n) => person(n)?.met).length} of ${deciders.length} people who decide or pay have been met`, cites: a.book.deals.map((d) => d.debrief?.id).filter(Boolean).slice(0, 3) },
      { name: "Support", score: support, why: `${openNoOwner} customer request(s) waiting without a reply`, cites: [`${a.id}/requests.csv`] },
      { name: "Momentum", score: momentum, why: `${reds} urgent risk(s) open`, cites: a.risks.filter((x) => x.level === "red").map((x) => x.id).slice(0, 3) },
    ].map((p) => ({ ...p, cites: p.cites.filter((c) => E[c]) }));
    const w = [0.3, 0.2, 0.2, 0.15, 0.15];
    const hs = Math.round(parts.reduce((s, p, i) => s + p.score * w[i], 0));
    a.healthScore = { score: hs, color: hs >= 70 ? "green" : hs >= 45 ? "amber" : "red", label: hs >= 70 ? "Healthy" : hs >= 45 ? "Watch" : "At risk", parts };
    a.lifecycle = { stage: a.days_to_renewal != null && a.days_to_renewal < 180 ? "Renew" : adoption < 60 ? "Adopt" : "Expand", note: a.days_to_renewal != null ? `Renewal in ${a.days_to_renewal} days` : "" };

    // ---------- tickets (support tickets + request log + live alerts) ----------
    const tickets = [];
    for (const t of data("tickets.json")?.tickets || []) tickets.push({ id: t.id, subject: t.subject, from: t.requester, opened: t.opened, status: t.status, owner: t.assignee || "", closed: t.closed || null, thread: t.conversation, cites: [t.id] });
    for (const q of pw["requests.csv"] ? parseCSV(pw["requests.csv"].text) : []) {
      const ex = tickets.find((t) => t.id === q.request_id);
      if (ex) { ex.note = q.summary; if (/open|pending/i.test(q.status)) ex.status = q.status; continue; }
      tickets.push({ id: q.request_id === "(none)" ? `REQ-${q.opened.slice(5).replace("-", "")}` : q.request_id, subject: q.summary.split(".")[0], note: q.summary, from: q.from, opened: q.opened, status: q.status, owner: q.owner, via: q.how_it_arrived, cites: [`${a.id}/requests.csv`] });
    }
    for (const sid of a.signals) for (const rec of E[sid]?.records || []) if (rec.kind === "request") for (const q of parseCSV(rec.text)) if (!tickets.find((t) => t.id === q.request_id)) tickets.push({ id: q.request_id, subject: q.summary.split(".")[0], note: q.summary, from: q.from, opened: q.opened, status: q.status, owner: q.owner, via: q.how_it_arrived, cites: [sid], live: true });
    for (const t of tickets) {
      const open = /open|pending/i.test(t.status);
      t.open = open;
      t.age = days(t.opened, r.asOf);
      t.priority = !open ? "Low" : /urgent/i.test(t.note || t.subject) || (t.age > 30 && !t.owner) ? "Urgent" : !t.owner ? "High" : "Normal";
      t.color = { Urgent: "red", High: "amber", Normal: "blue", Low: "grey" }[t.priority];
      t.waiting = open ? `${t.age} days` : "";
    }
    const prio = { Urgent: 0, High: 1, Normal: 2, Low: 3 };
    tickets.sort((x, y) => prio[x.priority] - prio[y.priority] || String(y.opened).localeCompare(String(x.opened)));
    a.tickets = tickets;

    // ---------- activity timeline with attachments ----------
    const acts = [];
    for (const c of data("calls_index.json")?.calls || []) {
      const id = c.path ? `${a.id}/${c.path}` : `${a.id}/calls_index.json`;
      acts.push({ type: "call", date: c.date, title: c.title, who: [...(c.customer || []), ...(c.flytbase || [])].join(", "), summary: c.summary, actions: c.actions, cites: [id] });
    }
    (data("mail_log.json")?.mail || []).forEach((mm, i) => {
      if (mm.kind !== "person") return;
      const id = `${a.id}/mail/${i}`;
      E[id] = { id, kind: "activity", account: a.id, label: `${mm.subject}`, human: `Email · ${shortDate(mm.date)}`, where: `${a.id}/mail_log.json`, text: `From: ${mm.from}\nTo: ${mm.to}\nDate: ${mm.date}\nSubject: ${mm.subject}\n\n${mm.body || "(body in emails/ thread)"}` };
      const thread = Object.keys(pw).find((p) => p.startsWith("emails/") && p.includes(mm.date));
      acts.push({ type: "email", date: mm.date, title: mm.subject, who: `${mm.from} → ${mm.to}`, summary: (mm.body || "").replace(/\s+/g, " ").slice(0, 180), cites: [id, thread ? `${a.id}/${thread}` : null].filter(Boolean) });
    });
    for (const t of tickets) acts.push({ type: "ticket", date: t.opened, title: `${t.id} · ${t.subject}`, who: t.from, summary: `${t.status}${t.owner ? ` · ${t.owner}` : " · no owner"}`, cites: t.cites });
    (data("internal_notes.json")?.notes || []).forEach((n) => acts.push({ type: "note", date: n.date, title: "Internal note", who: n.from, summary: n.text, cites: [`${a.id}/internal_notes.json`] }));
    for (const sid of a.signals) acts.push({ type: "alert", date: E[sid].date, title: E[sid].label.split(": ").pop(), who: "Live alert", summary: E[sid].text, cites: [sid] });
    (data("invoices.json")?.invoices || []).forEach((iv) => acts.push({ type: "invoice", date: iv.issued, title: `${iv.number} · ${iv.what}`, who: "Accounts", summary: `${iv.amount != null ? money(iv.amount) : "Amount in Schedule 2"} · ${iv.status}${iv.paid ? ` ${iv.paid}` : ""}`, cites: [`${a.id}/invoices.json`] }));
    acts.sort((x, y) => String(y.date).localeCompare(String(x.date)));
    a.activities = acts.map((x) => ({ ...x, cites: x.cites.filter((c) => E[c]) }));
    a.timelineLast = acts.find((x) => x.type !== "alert")?.date;

    // ---------- plays: who, how, draft ----------
    for (const m of a.moves) {
      m.role = ROLES[m.owner.name] || "Customer Success";
      m.withRoles = (m.with || []).map((x) => ROLES[x.name] || x.name);
      Object.assign(m, play(m, a, r, money));
      m.short = shortTitle(m);
    }

    // ---------- plain-English summary + the five answers ----------
    const top = a.moves[0];
    const red = a.risks.filter((x) => x.level === "red").sort((x, y) => ["Deadline", "Champion leaving", "Renewal", "Product", "Unanswered", "Going cold"].indexOf(x.type) - ["Deadline", "Champion leaving", "Renewal", "Product", "Unanswered", "Going cold"].indexOf(y.type));
    const rd = pipeline.find((p) => p.kind === "deal" && (/renew/i.test(p.title) || p.synthetic) && p.decider) || pipeline.find((p) => p.kind === "deal" && p.decider);
    const procFact = a.facts.find((f) => /\b(signs?|vote|approv|budget|call-off|finance)\b/i.test(f.text));
    const finMail = Object.keys(E).find((k) => k.startsWith(`${a.id}/emails/`) && /finance/i.test(k));
    const champ = a.people.filter((p) => p.met).sort((x, y) => ["ally", "warm", "neutral", "guarded"].indexOf(x.relationship) - ["ally", "warm", "neutral", "guarded"].indexOf(y.relationship))[0];
    a.summary = `${a.name} pays ${k(a.annual)} a year and the contract ends in ${a.days_to_renewal} days with no auto-renew. Real usage backs ${k(renewal?.backed)} of it; ${k(renewal?.at_risk)} sits on docks nobody flies. ${red[0] ? `Biggest worry: ${red[0].title.replace(/ — unanswered$/, " (no reply yet)").replace(/^(FB-\d+|REQ-[\w-]+) — /, "").replace(/^([^:]+): /, "$1 — ")}.` : ""}`;
    a.answers = [
      { q: "What is the book worth?", short: `${k(a.forecast.commit)} we can back · ${k(renewal?.at_risk)} at risk`, more: `${a.forecast.commitWhy}. ${a.book.claimsApart.filter((c) => c.implied).length ? `Big claims (${k(a.forecast.unverified)}) are not counted until someone proves them.` : ""}`, tab: "deals", color: "blue", cites: a.forecast.cites },
      { q: "Who holds the power?", short: rd?.decider ? `${rd.decider} decides${/renew|contract/i.test(rd.title) ? " the renewal" : ` “${rd.title.split(" (")[0]}”`}${person(rd.decider)?.met === false ? " — never met" : person(rd.decider) ? ` (${person(rd.decider).relationship})` : ""}` : "Decider unknown", more: `${champ ? `Warmest contact: ${champ.name} (${champ.relationship}). ` : ""}${procFact ? procFact.text : finMail ? "Finance has asked for cost per site before anything is signed." : ""}`, tab: "people", color: "violet", cites: [...(rd?.deciderCites || []), procFact?.id, finMail].filter((c) => c && E[c]).slice(0, 3) },
      { q: "What do we do first?", short: top ? top.short : "Nothing urgent", more: a.moves.slice(0, 3).map((m, i) => `${i + 1}. ${m.short} — ${m.owner.name}, by ${shortDate(m.due)}`).join("\n"), tab: "plan", color: "orange", cites: top?.cites?.slice(0, 2) || [] },
      { q: "What is about to go wrong?", short: (() => { const up = red.filter((x) => x.turns_bad && x.turns_bad >= r.asOf).sort((x, y) => x.turns_bad.localeCompare(y.turns_bad))[0]; const over = red.filter((x) => x.turns_bad && x.turns_bad < r.asOf).length; return `${red.length} urgent${over ? ` · ${over} already overdue` : ""}${up ? ` · next turns bad ${shortDate(up.turns_bad)}` : ""}`; })(), more: red.slice(0, 3).map((x) => `• ${x.title}`).join("\n"), tab: "risks", color: "red", cites: red.slice(0, 2).flatMap((x) => x.cites.slice(0, 1)) },
      { q: "What do we still not know?", short: `${a.gaps.length} open questions`, more: a.gaps.slice(0, 3).map((g) => `• ${g.what.split(/\. /)[0].replace(/\.$/, "")} → ask ${g.who.split(/[—(;]/)[0].trim()}`).join("\n"), tab: "unknowns", color: "amber", cites: a.gaps.slice(0, 2).flatMap((g) => g.cites.slice(0, 1)) },
    ];
    for (const g of a.gaps) g.whoShort = g.who.split(/[—(;]/)[0].trim();
  }
  // short names + portfolio roll-up (sums only within a currency)
  for (const a of r.accounts) a.short = a.name.replace(/\b(Police|Alliance|Industrial|Group|Authority|Estates|Ltd|Limited)\b/g, "").replace(/\s+/g, " ").trim();
  const byCur = {};
  for (const a of r.accounts) {
    const c = (byCur[a.currency] ||= { currency: a.currency, symbol: a.symbol, accounts: [], annual: 0, backed: 0, atRisk: 0 });
    c.accounts.push(a.short); c.annual += a.annual || 0; c.backed += a.forecast.commit || 0; c.atRisk += a.book.at_risk || 0;
  }
  const allMoves = r.accounts.flatMap((a) => a.moves.map((m) => ({ id: m.id, due: m.due, acc: a.id })));
  r.portfolio = {
    currencies: Object.values(byCur),
    renewals120: r.accounts.filter((a) => a.days_to_renewal != null && a.days_to_renewal <= 120).map((a) => ({ id: a.id, short: a.short, days: a.days_to_renewal })),
    red: r.accounts.reduce((t, a) => t + a.risks.filter((x) => x.level === "red").length, 0),
    dueThisWeek: allMoves.filter((m) => days(r.asOf, m.due) <= 7).length,
    deadlines: r.accounts.flatMap((a) => (a.deadlines || []).filter((d) => d.date && d.date >= r.asOf).map((d) => ({ ...d, acc: a.id, short: a.short }))).sort((x, y) => x.date.localeCompare(y.date)),
  };
  // Monday brief: plain text a CSM can paste to their manager
  for (const a of r.accounts) {
    const red = a.risks.filter((x) => x.level === "red");
    a.brief = [
      `${a.name} — Monday brief (${fmtDate(r.asOf)})`,
      `Health ${a.healthScore.score}/100 (${a.healthScore.label}). ${a.summary}`,
      ``, `Worth: ${a.answers[0].short}.`,
      `Power: ${a.answers[1].short}. ${a.answers[1].more}`,
      ``, `First moves:`, ...a.moves.slice(0, 3).map((m) => `${m.rank}. ${m.short} — ${m.owner.name}, by ${fmtDate(m.due)}`),
      ``, `About to go wrong:`, ...red.slice(0, 4).map((x) => `- ${x.title}${x.turns_bad ? ` (turns bad ${fmtDate(x.turns_bad)})` : ""}`),
      ``, `Still unknown:`, ...a.gaps.slice(0, 3).map((g) => `- ${g.what.split(/\. /)[0].replace(/\.$/, "")} → ask ${g.whoShort}`),
      ``, `Sources: every figure links to its record in Flightdeck.`,
    ].join("\n");
  }
  r.stages = STAGES;
  r.roles = ROLE_LIST;
  return r;
}

function shortTitle(m) {
  const t = m.title.replace(/ — with .*$/, "").replace(/\(via .*\)/, "").replace(/: Insp\. Karen Mbeki — /, ": ");
  return t.length > 90 ? t.slice(0, 88) + "…" : t;
}

// ---------- playbooks ----------
function play(m, a, r, money) {
  const due = fmtDate(m.due);
  const id = m.id;
  const P = (method, steps, draft, talk) => ({ how: { method, steps, draft, talk } });
  if (id === "mv:urgent_request") return P("Customer rescue · Mutual action plan", [
    "Call Insp. Karen Mbeki today. Acknowledge the email and ticket FB-11206 and say a written answer comes by Friday.",
    "With Pranjal Suyal (Solutions Engineer): fix training dates for the extra operators before 5 December. The operator-training offer is already won.",
    "Name one on-day contact and a backup for 5 December, with phone numbers and a response time. Priority support is already won.",
    "Get the field team to check the batteries on docks ECPA-D16 and ECPA-D29 before the event (17 battery warnings each).",
    "Send the written plan, log it on FB-11206, and book a 15-minute check-in for 3 December.",
  ], {
    to: "Insp. Karen Mbeki", subject: "Your 5 December event — training dates and on-day cover",
    body: `Karen,\n\nThank you for writing, and sorry you had to chase. Here is what we will do before Saturday 5 December:\n\n1. Training: [N] more of your officers trained on [date 1] and [date 2], run by our solutions engineer.\n2. Cover on the day: your named contact is [name, phone], backed up by [name, phone]. We will answer within [X] minutes all day.\n3. Batteries: our field team will check the aircraft on docks D16 and D29 before the event and swap any battery that is below capacity.\n\nThis is logged on ticket FB-11206. Can we have 15 minutes on 3 December to walk through the day?\n\n[Your name]`,
  }, ["What would a good day on 5 December look like for your unit?", "Which docks will carry most of the work?"]);
  if (id === "mv:champion_leaves") return P("Multi-threading · Champion change", [
    "Book a call with Rhys Calder this week. Thank him, and ask who takes over the drone programme in January.",
    "Show the renewal evidence: the flight log by force (Westmere 18 docks and Metro Central 9 fly; Tarn Valley and Norwold have not) and Karen's verified 14-of-18 figure.",
    "Agree the renewal shape now, while he can still say yes. Ask him to write it down.",
    "Ask for three introductions: the procurement lead, each force's finance officer, and his successor.",
    "Send a short mutual action plan with dates up to 28 February 2027.",
  ], {
    to: "Rhys Calder", subject: "Before you hand over — renewal and introductions",
    body: `Rhys,\n\nThank you for letting us know, and congratulations on the new role. Before January, I want to make sure what we've built doesn't depend on one inbox.\n\nAttached is usage by force since May: Westmere and Metro Central fly every month; Tarn Valley and Norwold have not flown live missions yet. I'd like to agree the renewal shape with you on that basis.\n\nCould you also introduce us to:\n• the alliance procurement lead (she joined the pilot review in December 2025),\n• the finance officer at each force who approves its call-off,\n• your successor, once named?\n\nCould we have 30 minutes before [date]?\n\n[Your name]`,
  }, ["What will your successor need to see to keep this going?", "Who at each force signs the call-off?"]);
  if (id.startsWith("mv:unblock:a_tarn")) return P("Remove a blocker · Compliance", [
    "Ask the support desk who raised FB-10412 and what it asks for. It has been open since June with no owner.",
    "If it is Tarn Valley's DPIA request, send the data-flow documents and the standard data processing terms (Schedule 3).",
    "Offer Fatima Osei a 30-minute call with an engineer to go through the data flows.",
    "Do not promise a go-live date. Promising one is what put this deal at risk this morning.",
    "Close FB-10412 with a note saying what was sent.",
  ], {
    to: "Fatima Osei", subject: "Data-flow documents for your DPIA",
    body: `Fatima,\n\nI'm sorry this has taken so long. Attached are the data-flow documents and our standard data processing terms for the docks at Tarn Valley.\n\nIf it helps, one of our engineers can walk you through how footage and telemetry move, where they are stored and who can see them — 30 minutes, at a time that suits you.\n\nThere is no rush on dates from our side; the assessment should take the time it needs.\n\n[Your name]`,
  }, ["What else does the assessment need from us?", "Who else signs the DPIA after you?"]);
  if (id.startsWith("mv:unblock:a_westmere")) return P("Business case · Challenger (teach with numbers)", [
    "Ask Ewan Brooks one question: what does a helicopter hour cost Metro Central and Westmere?",
    "Build cost per flight: £10,000 per dock per year divided by live missions per dock (from the flight log).",
    "Add Karen's example: two missing-person finds in under 12 minutes against about 40 for the helicopter.",
    "Send a one-page comparison. Do not pitch extra docks until Ewan has the number. Pitching too early cost us this morning.",
  ], {
    to: "Ewan Brooks", subject: "Cost per flight vs helicopter hour — one number I need",
    body: `Ewan,\n\nI'm putting together a straight comparison of what a dock flight costs against a helicopter hour, using your forces' own flight logs.\n\nThe one figure I don't have is your cost per helicopter hour. Could you share it, or a range?\n\nI'll send the one-page result back to you before anyone talks about more docks.\n\n[Your name]`,
  }, ["How do you decide where the money goes between air support options?", "When is next year's budget decided?"]);
  if (id.startsWith("mv:unblock:a_tender")) return P("Shape the requirements · Tender", [
    "Ask Rhys or Karen for an introduction to the alliance procurement lead (Hannah Doyle in the morning notes).",
    "Offer a costed operating model: docks, operators, shifts and cost per flight, based on what the 35 docks really do.",
    "Use Karen's staffing facts: scaling to 30 docks needs nine more trained operators and shift cover.",
    "Ask for the timetable and how bids will be scored.",
  ], {
    to: "Alliance procurement lead (via Rhys Calder)", subject: "A costed operating model for the framework specification",
    body: `Hello,\n\nWe met briefly at the pilot review in December 2025. As the alliance prepares the framework specification, we can share a costed operating model built from the 35 docks already in service: what they fly, the staff they need, and the cost per flight.\n\nWould that be useful? I'd also welcome the timetable and how bids will be evaluated.\n\n[Your name]`,
  }, ["What has to be true for the specification to be signed off?", "How will bids be scored?"]);
  if (id.startsWith("mv:unblock:b_renewal")) return P("Renewal · Finance-led business case", [
    "Tell Stefan Roy first that you are answering Group Finance, so it doesn't look like going around him.",
    "Reply to the finance mailbox with a quote per plant: €10,000 per dock per year × 14 docks = €140,000.",
    "Attach usage by dock: 4 docks fly nightly, 9 a few times a month, 1 has never flown. Be honest. Finance will check.",
    "Do not use the €1.2M savings figure. Nobody has seen the working.",
    "Ask for a 30-minute meeting with the finance controller (Nadia Rahman in the morning notes).",
  ], {
    to: "Group Finance, Aldermoor", subject: "Renewal quote by plant — drone docks",
    body: `Hello,\n\nThank you for your note of 8 October, and apologies for the slow reply. As asked, the renewal is shown per plant below: €10,000 per dock per year, 14 docks, €140,000 in total, for 1 February 2027 to 31 January 2028.\n\n[table: plant · dock · price · flights in the last 3 months]\n\nWe've included real usage so you can see where the docks are earning their keep — and where they aren't yet. We'd like to agree a plan for the quieter ones before renewal.\n\nCould we have 30 minutes with whoever owns this decision?\n\n[Your name]`,
  }, ["How will finance judge whether the programme is worth renewing?", "Which plants does finance see as a priority?"]);
  if (/FB-10903/.test(id)) return P("Technical fix · Escalation", [
    "Ask Stefan Roy for the name of the group IT lead (Owen Fitch in the morning notes).",
    "Send IT the facts: dock AD-01 dropped offline 5 times in September and October, and the dock is healthy when connected.",
    "Offer a 20-minute call with an engineer to look at the plant's network link.",
    "Close FB-10903 once the link is stable, and tell the plant.",
  ], { to: "Group IT (via Stefan Roy)", subject: "Dock at Plant 11 — network link drops", body: `Hello,\n\nThe drone dock at Plant 11 has gone offline for days at a time, five times since September. The dock itself is healthy when connected; the plant's network link drops.\n\nCould someone from IT spend 20 minutes with our engineer to look at the link? Ticket FB-10903 has the detail.\n\n[Your name]` }, []);
  if (/casestudy/.test(id)) return P("Expansion · Proof before promotion", [
    "Agree with Stefan Roy that the case study will use real usage numbers, not the €1.2M headline.",
    "Find one plant manager willing to be quoted. Plant 7 (Beatriz Alonso) is the only plant contact we have.",
    "Ask finance to confirm one saving we can stand behind.",
    "Then offer to present it to the 40-plant sister company with Stefan.",
  ], { to: "Stefan Roy", subject: "The case study — what will make it stick", body: `Stefan,\n\nI want the case study to survive the first question from your sister company's finance team. So I'd like to build it on figures we can show: flights by plant, and one saving finance has confirmed.\n\nCould you introduce me to a plant manager willing to be quoted, and to whoever in finance owns the savings figure?\n\n[Your name]` }, ["What does your sister company's board need to see?"]);
  if (id.startsWith("mv:offer:")) return P("Discovery · SPIN questions before pitching", [
    "Call Beatriz Alonso (Plant 7). She asked for night alerts to go to more than one person and nobody asked why.",
    "Ask what happened, who should get the alert, and what goes wrong at night today.",
    "Only if the need is clear, explain night-time priority support (€50,000 offer).",
  ], { to: "Beatriz Alonso", subject: "Night alerts at Plant 7", body: `Beatriz,\n\nYou asked our support desk about sending night alerts to more than one person. I'd like to understand what prompted it — is something being missed at night?\n\nCould we talk for 15 minutes this week?\n\n[Your name]` }, ["What happens today when an alert comes in at 3 am?", "Who needs to know, and how fast?", "What would it cost if an alert was missed?"]);
  if (/:summary$/.test(id)) return P("Executive reporting", [
    "Use the flight log by force (already cleaned in Flightdeck) to make a one-page chart.",
    "Split by force, as Rhys asked on 2 June.",
    "Send it monthly on the 1st, and copy the procurement lead once introduced.",
  ], null, []);
  if (id.startsWith("mv:intro:")) return P("Multi-threading", [
    `Ask the warmest contact on the account to introduce ${m.title.replace("Get introduced to ", "").split(" (")[0]}.`,
    "Explain why in one line: the renewal decision needs their view.",
    "Send a short agenda and keep it to 20 minutes.",
  ], null, []);
  if (/batter/i.test(m.title)) return P("Customer care", [
    "Reply to Karen's August battery email today, and apologise for the 99-day silence.",
    "Get the field team to swap the batteries on docks D16 and D29.",
    "Fold this into the 5 December event reply (action #1).",
  ], { to: "Insp. Karen Mbeki", subject: "RE: Batteries on two docks", body: `Karen,\n\nI'm sorry this went unanswered. Our field team will check and replace the batteries on the two docks this week — I'll confirm the date today.\n\n[Your name]` }, []);
  const tp = topicPlay(m, a, money, P);
  if (tp) return tp;
  return P("Follow-up", [m.why], null, []);
}

// Topic playbooks: reusable for any account, filled in with that account's own people and numbers.
function topicPlay(m, a, money, P) {
  const met = a.people.filter((p) => p.met);
  const champ = met.find((p) => ["ally", "warm"].includes(p.relationship)) || met[0];
  const first = (n) => (n || "").split(" ")[0];
  const by = (re) => met.find((p) => re.test(p.role));
  const dl = (re) => (a.deadlines || []).find((d) => re.test(d.text));
  switch (m.topic) {
    case "stopped_docks": return P("Early warning · Save the renewal", [
      `Call ${champ?.name} today. Say you noticed ${a.usage.tiers.stopped.join(", ")} stopped flying two weeks ago and ask what changed. Don't assume it's a fault.`,
      "Ask the Solutions Engineer to check each dock's logs for errors, a schedule change or a battery or weather hold, before the call if possible.",
      "If the cause is on our side, fix it and confirm in writing. If it's theirs (staffing, schedule, site change), agree a restart date.",
      "Log it as a ticket so it has a number and an owner, and check again in 7 days.",
    ], { to: champ?.name, subject: "Three docks have gone quiet — can we help?", body: `${first(champ?.name)},\n\nA quick one: ${a.usage.tiers.stopped.join(", ")} flew most nights until two weeks ago and have flown nothing since, though they're still online. Has something changed on site — a schedule, a team, a plant? If anything on our side is getting in the way, we'll fix it this week.\n\nCould we speak for 10 minutes today or tomorrow?\n\n[Your name]` }, ["What changed two weeks ago on those sites?", "Who sets the patrol schedule there now?"]);
    case "golive": {
      const plan = dl(/go-live|plan/i), vote = dl(/board|vote/i);
      const off = a.book.offers.find((o) => /pilot|certif|train/i.test(o.title) && o.status === "open");
      const ins = by(/insurance/i);
      return P("Rescue a stalled go-live · Mutual action plan", [
        `Call ${champ?.name} and agree the plan in one conversation: who flies it, when it's commissioned, when the insurer is told.`,
        off ? `Book the ${off.title.toLowerCase()} (${money(off.value)} — open offer). Without a certified pilot it cannot fly.` : "Arrange certified operators. Without them it cannot fly.",
        "Book an engineer visit to run the commissioning flight. The installer never did one.",
        ins ? `Ask ${ins.name} to notify the insurer before the first flight. The policy requires it, and the dock isn't declared.` : "Notify the insurer before the first flight.",
        `Send ${first(champ?.name)} the dated plan in writing${plan ? ` by ${shortDate(plan.date)}` : ""}${vote ? `, so it's in hand before the board vote on ${shortDate(vote.date)}` : ""}.`,
      ], { to: champ?.name, subject: "Your dock: a dated plan to get it flying", body: `${first(champ?.name)},\n\nI'm sorry you've waited since the install. Here is how we get the north-entrance dock flying night patrols:\n\n1. Pilots: two of your staff certified on [dates]${off ? ` (course: ${money(off.value)})` : ""}.\n2. Commissioning: our engineer on site [date] to run the first flight.\n3. Insurance: we'll help you notify your insurer before that flight, as the policy requires.\n4. First night patrol of the north entrance: [date].\n\nI'll join the residents' board${vote ? ` on ${shortDate(vote.date)}` : ""} if that helps.\n\n[Your name]` }, ["Which nights and which entrance matter most?", "Who on site could be trained to fly it?"]);
    }
    case "board_brief": {
      const chair = by(/chair|board/i), vote = dl(/board|vote/i);
      return P("Executive alignment · Before a vote", [
        `Send ${chair?.name || "the board chair"} a one-page brief before ${vote ? shortDate(vote.date) : "the meeting"}: what was bought, why it hasn't flown yet, the dated plan, and what (if anything) needs a vote.`,
        "Lead with what residents asked for: night patrol of the two entrances. The original pitch (mapping the estate) isn't what they need.",
        "Separate what's already paid from any new spend, such as pilot training, so the vote is about one clear thing.",
        `Offer to attend, or have ${first(champ?.name)} present it with you.`,
      ], { to: chair?.name, subject: "Before the board meets — where the drone dock stands", body: `${first(chair?.name)},\n\nAhead of the residents' board${vote ? ` on ${shortDate(vote.date)}` : ""}, a short brief: the dock at the north entrance was installed but never commissioned, and no one on site is certified to fly it. We've agreed a dated plan with ${first(champ?.name)} to fix that, and to focus on what residents need — night patrol of the entrances.\n\nThe only new spend is optional pilot training. I'm happy to join the meeting for 10 minutes.\n\n[Your name]` }, ["What will residents want to hear at the meeting?", "What would make this an easy yes?"]);
    }
    case "privacy_docs": {
      const dpo = by(/data protection|privacy/i);
      return P("Remove a blocker · Compliance", [
        `Send ${dpo?.name || "the data protection lead"} written answers to her four questions: what's collected, where video is stored (and in which country), how long it's kept and how it's deleted, and who can access it.`,
        "Attach the standard data processing terms (Schedule 3) and offer a 30-minute call with an engineer.",
        "Apologise plainly for the months of silence, and close the open ticket with what was sent.",
        "Don't promise a go-live date. Let the assessment run its course.",
      ], { to: dpo?.name, subject: "Your questions on the container yard dock — answers", body: `${first(dpo?.name)},\n\nI'm sorry your request from the spring went unanswered. Here are the answers you need for the assessment:\n\n1. Data collected: [video, stills, telemetry, location].\n2. Where video is stored: [service, country].\n3. Retention and deletion: [periods and method].\n4. Who can access it, and controls: [roles and controls].\n\nOur standard data processing terms are attached. An engineer can walk you through it whenever suits.\n\n[Your name]` }, ["Who else signs the assessment after you?"]);
    }
    case "finance_value": {
      const payer = by(/finance|controller/i);
      return P("Renewal · Finance-led business case", [
        `Build a one-page value case for ${payer?.name || "finance"} from the flight records: flights per dock per site and price per dock, not the headline saving.`,
        "Show where it earns its keep and where it doesn't yet (sites that don't fly), with a dated plan for those.",
        `Ask ${first(champ?.name)} to introduce you, so it doesn't land as going around him.`,
        "Ask what finance needs to see in the accounts to renew, and write that down as the success measure.",
      ], { to: payer?.name, subject: "What the docks actually do — by site", body: `${first(payer?.name)},\n\nAhead of the renewal I'd like to give you a straight view of what the docks do, from the flight records rather than estimates: flights per site per month, and the cost per dock.\n\nCould we take 30 minutes, and could you tell me what you'd need to see in the accounts to be comfortable renewing?\n\n[Your name]` }, ["What would you need to see in the accounts to renew?", "Which patrol costs would you expect to change?"]);
    }
    case "knowledge_capture": {
      const c = by(/contractor/i), off = a.book.offers.find((o) => /playbook|rollout|rota/i.test(o.title) && o.status === "open");
      return P("Hand-over risk · Capture before it walks out", [
        `Book two sessions with ${c?.name || "the contractor"} before he leaves: launch steps, patrol routes, alert rota, and who to call for each fault.`,
        "Have the Solutions Engineer write it up as a runbook and get the operations team to sign it off.",
        off ? `Position the ${off.title.toLowerCase()} (${money(off.value)}) as the way to do this properly.` : "Store it where the operations team can find it.",
        "Name an internal owner at the customer for each part of the runbook.",
      ], { to: champ?.name, subject: "Before the contractor leaves — let's write it down", body: `${first(champ?.name)},\n\nThe launch steps, patrol routes and alert rota currently live in ${first(c?.name)}'s head, and his contract ends soon. I'd like our engineer to sit with him twice before then and turn it into a written runbook your team owns.\n\nCan we book those sessions this week?\n\n[Your name]` }, ["Who will own each patrol once he's gone?"]);
    }
    case "network_register": {
      const it = by(/IT|infrastructure/i);
      return P("Technical readiness · Network change", [
        `Send ${it?.name || "IT"} the exception request details for each dock: device type, location, ports and destinations, data volumes, and an owner.`,
        "Ask for them to be registered before the cut-over, so no dock loses network access.",
        "Diary a check the week before the change.",
      ], { to: it?.name, subject: "Registering the drone docks before the network change", body: `${first(it?.name)},\n\nSo the docks keep working after the move to the segmented network, here are the details your notice asks for, per dock: [type, location, ports/destinations, data volumes, owner].\n\nCould you confirm they're registered before the change?\n\n[Your name]` }, []);
    }
    case "expansion_reply": {
      const asker = met.find((p) => m.title.includes(p.name));
      const payer = by(/finance|controller/i);
      return P("Expansion · Earn the right to grow", [
        `Reply to ${asker?.name || "them"} within two days, and apologise for the wait.`,
        `Be straight: a price for more sites is easy, but ${payer ? `${payer.name} (finance)` : "finance"} has to see value in the current sites first, so the renewal case comes first.`,
        "Offer an outline per site, sized from what the current docks actually do. Leave sites that don't fly yet out of the comparison.",
        "Propose a joint plan: renewal value case → fix sites that don't fly → expansion proposal, each with a date.",
      ], { to: asker?.name, subject: "Re: more sites — how we'd get there", body: `${first(asker?.name)},\n\nSorry for the slow reply. We'd be glad to price more sites. To make it land with ${payer ? first(payer.name) : "finance"}, I suggest we first show what the current docks deliver, site by site, from the flight records, then bring an expansion outline sized on that.\n\nCould we agree dates for both this week?\n\n[Your name]` }, ["Who besides you needs to say yes to more sites?", "What would finance need to see first?"]);
    }
    case "offer_discovery": return P("Discovery · Questions before pitching", ["Ask what problem it would solve and what happens today without it.", "Only propose once the need is clear and the person who pays has heard it."], null, ["What happens today when this goes wrong?", "Who else would need to agree?"]);
    default: return null;
  }
}
