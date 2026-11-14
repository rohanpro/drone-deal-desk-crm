// The decision engine. Turns the raw MCP store into the five answers per account.
// Rule: every number and every claim carries `cites` — ids that resolve in the evidence index.
// Nothing here invents a person or an id: names come from get_my_accounts, paperwork,
// get_flytbase_team or the morning debrief (seed/morning.json), and are labelled by source.
import { parseCSV, cleanForceLog, days, addDays, fridayOf, fmtDate } from "./parse.mjs";

export function analyze(store, morning) {
  const S = store.sources || {};
  const accountsDoc = S.accounts || { accounts: [], files: [] };
  const signals = S.signals?.signals || [];
  const team = S.team?.people || [];
  const notes = Array.isArray(S.notes) ? S.notes : S.notes?.notes || [];
  const E = {}; // evidence index
  const ev = (id, o) => (E[id] = { id, ...o }, id);

  // "Today" is the later of the wall clock and the newest live event (the game's clock runs ahead).
  const latestSignal = signals.map((s) => s.dated).sort().pop();
  const today = new Date().toISOString().slice(0, 10);
  const asOf = latestSignal && latestSignal > today ? latestSignal : today;

  // ---------- evidence index: everything citable ----------
  for (const f of accountsDoc.files || []) ev(f.id, { kind: "file", account: f.account, label: f.title, where: `get_file("${f.id}")`, text: S[`file_${f.id}`]?.text });
  for (const s of signals) ev(s.id, { kind: "signal", account: s.account, label: s.title, where: "get_signals", date: s.dated, text: s.summary, records: s.records });
  for (const p of team) ev(`team:${p.id}`, { kind: "team", label: `${p.name} — ${p.role}`, where: "get_flytbase_team" });
  for (const d of morning.deals) ev(d.id, { kind: "debrief", account: d.account, label: `Debrief: ${d.title}`, where: "Play page › This morning", text: [d.why_stopped, d.decides && `Decides: ${d.decides}. Pays: ${d.pays}.`, d.blocker && `Blocker: ${d.blocker}`, d.unlock && `Unlock: ${d.unlock}`, d.came_up_with && `Came up with: ${d.came_up_with.join(", ")}`, d.at_risk_by && `Put at risk by: ${d.at_risk_by}`].filter(Boolean).join("\n") });
  for (const p of morning.never_met) ev(p.id, { kind: "debrief", account: p.account, label: `Never met: ${p.name}, ${p.role}`, where: "Play page › This morning" });
  for (const d of morning.doors_closed) ev(d.id, { kind: "debrief", account: d.account, label: `Door closed: ${d.who} — ${d.topic}`, where: "Play page › This morning", text: d.because });
  ev("dbf_book", { kind: "debrief", label: `Morning book: $${morning.book_usd.toLocaleString()}`, where: "Play page › This morning" });

  const out = [];
  for (const acc of accountsDoc.accounts || []) {
    const pw = S[`paperwork_${acc.id}`]?.records || [];
    const rec = Object.fromEntries(pw.map((r) => [r.path, r]));
    const data = (p) => rec[p]?.data;
    const pref = (p) => `${acc.id}/${p}`;
    for (const r of pw) ev(pref(r.path), { kind: "record", account: acc.id, label: r.path, where: `get_paperwork_record("${acc.id}", "${r.path}")`, text: r.text ?? JSON.stringify(r.data, null, 1) });
    for (const f of acc.facts) ev(f.id, { kind: "fact", account: acc.id, label: `“${f.text}”`, where: "get_my_accounts › facts", status: f.status, said_by: f.said_by, verified_by: f.verified_by, minute: f.learned_at_minute });
    for (const p of acc.stakeholders) ev(p.id, { kind: "person", account: acc.id, label: `${p.name} — ${p.role}`, where: "get_my_accounts › stakeholders", relationship: p.relationship });
    for (const o of acc.opportunities) ev(o.id, { kind: "deal", account: acc.id, label: o.title, where: "get_my_accounts › opportunities", stage: o.stage, text: o.blocker ? `Blocker (${o.blocker.status}): ${o.blocker.text}` : "No blocker on file" });
    for (const o of acc.offers || []) ev(o.id, { kind: "offer", account: acc.id, label: `${o.title} (${o.status})`, where: "get_my_accounts › offers", value: o.value });
    for (const t of data("tickets.json")?.tickets || []) ev(t.id, { kind: "ticket", account: acc.id, label: `${t.id} ${t.subject} (${t.status})`, where: `${acc.id}/tickets.json`, text: t.conversation?.map((c) => `${c.date} ${c.from}: ${c.text}`).join("\n") });

    const profile = data("profile.json") || {};
    const cur = profile.currency === "GBP" ? "£" : profile.currency === "EUR" ? "€" : "$";
    const money = (n) => (n == null ? "—" : `${cur}${Math.round(n).toLocaleString("en-GB")}`);
    const devices = data("devices.json")?.docks || [];
    const annual = profile.renewal?.annual_value ?? data("invoices.json")?.first_year_total;
    const perDock = annual && devices.length ? annual / devices.length : null;
    const termEnds = profile.renewal?.term_ends;
    const calc = (id, label, value, formula, cites) => ev(`calc:${acc.id}:${id}`, { kind: "calc", account: acc.id, label, value, text: formula, cites });

    calc("per_dock", `Price per dock: ${money(perDock)} / year`, perDock, `${money(annual)} a year (contract.txt, profile.json › renewal) ÷ ${devices.length} docks (devices.json)`, [pref("contract.txt"), pref("profile.json"), pref("devices.json")]);

    // ---------- usage from raw flights ----------
    const flights = rec["flights.csv"] ? parseCSV(rec["flights.csv"].text) : [];
    const byMonth = {};
    const byDock = Object.fromEntries(devices.map((d) => [d.dock_id, 0]));
    for (const f of flights) {
      const m = f.date.slice(0, 7);
      (byMonth[m] ||= { flights: 0, docks: new Set(), scheduled: 0, early: 0 });
      byMonth[m].flights++; byMonth[m].docks.add(f.dock_id);
      if (f.mode === "scheduled") byMonth[m].scheduled++;
      if (f.result === "returned_early") byMonth[m].early++;
      byDock[f.dock_id] = (byDock[f.dock_id] || 0) + 1;
    }
    const months = Object.keys(byMonth).sort();
    const last3 = months.slice(-3);
    const dockLast3 = Object.fromEntries(devices.map((d) => [d.dock_id, 0]));
    for (const f of flights) if (last3.includes(f.date.slice(0, 7))) dockLast3[f.dock_id]++;
    const tiers = { regular: [], light: [], none: [] };
    for (const d of devices) {
      const perMonth = dockLast3[d.dock_id] / Math.max(1, last3.length);
      tiers[perMonth >= 4 ? "regular" : perMonth > 0 ? "light" : "none"].push(d.dock_id);
    }
    const neverFlew = devices.filter((d) => !byDock[d.dock_id]).map((d) => d.dock_id);
    const events = rec["device_events.csv"] ? parseCSV(rec["device_events.csv"].text) : [];
    const batt = {}; const conn = {}; const offline = {};
    for (const e of events) {
      if (e.event === "battery_health_warning") batt[e.dock_id] = (batt[e.dock_id] || 0) + 1;
      if (e.event === "connection_lost") conn[e.dock_id] = (conn[e.dock_id] || 0) + 1;
      if (e.event === "offline") offline[e.dock_id] = (offline[e.dock_id] || 0) + 1;
    }
    const usage = {
      months: months.map((m) => ({ month: m, flights: byMonth[m].flights, docks_flying: byMonth[m].docks.size, scheduled: byMonth[m].scheduled, returned_early: byMonth[m].early })),
      docks: devices.map((d) => ({ dock: d.dock_id, flights_total: byDock[d.dock_id] || 0, flights_last3: dockLast3[d.dock_id], battery_warnings: batt[d.dock_id] || 0, connection_drops: conn[d.dock_id] || 0, offline_spells: offline[d.dock_id] || 0, last_seen: d.last_seen_online })),
      tiers, neverFlew, totalDocks: devices.length, flights: flights.length,
    };
    calc("tiers", `${tiers.regular.length} regular / ${tiers.light.length} light / ${tiers.none.length} idle docks (last 3 months)`, tiers, `flights.csv, ${last3[0]}…${last3.at(-1)}. Regular = 4+ flights a month on average; light = some flights; idle = none. Regular: ${tiers.regular.join(", ")}. Light: ${tiers.light.join(", ")}. Idle: ${tiers.none.join(", ") || "none"}.`, [pref("flights.csv"), pref("devices.json")]);
    calc("never_flew", `${neverFlew.length} of ${devices.length} docks never flew (May–Oct)`, neverFlew.length, `Docks in devices.json with no row in flights.csv: ${neverFlew.join(", ") || "none"}`, [pref("flights.csv"), pref("devices.json")]);
    const lastM = usage.months.at(-1), prevM = usage.months.at(-2);
    if (lastM) calc("docks_flying_last", `${lastM.docks_flying} of ${devices.length} docks flew in ${lastM.month}`, lastM.docks_flying, `Distinct dock_id in flights.csv for ${lastM.month}; ${prevM ? `${prevM.docks_flying} in ${prevM.month}` : ""}`, [pref("flights.csv")]);

    // ---------- force-level log (verified file), if this account has one ----------
    let forceLog = null;
    const flFile = (accountsDoc.files || []).find((f) => f.account === acc.id && S[`file_${f.id}`]?.text);
    if (flFile) {
      forceLog = cleanForceLog(S[`file_${flFile.id}`].text);
      forceLog.file = flFile.id;
      const forces = [...new Set(forceLog.rows.map((r) => r.force))];
      forceLog.summary = forces.map((f) => {
        const rows = forceLog.rows.filter((r) => r.force === f);
        const last = rows.at(-1);
        const live6 = rows.reduce((s, r) => s + r.live_missions, 0);
        const train6 = rows.reduce((s, r) => s + r.training_flights, 0);
        return { force: f, docks: last.docks_installed, live_missions: live6, training: train6, last_month: last.month, last_docks_live: last.docks_with_live_flights, operational: live6 > 0, series: rows.map((r) => ({ month: r.month, live: r.live_missions, docks_live: r.docks_with_live_flights })) };
      });
    }

    // ---------- people ----------
    const contacts = Object.fromEntries((profile.contacts_on_file || []).map((c) => [c.id, c]));
    const people = acc.stakeholders.map((p) => ({ ...p, met: true, last_contact: contacts[p.id]?.last_contact_before_handover || null, cites: [p.id, ...(contacts[p.id] ? [pref("profile.json")] : [])] }));
    for (const n of morning.never_met.filter((n) => n.account === acc.id)) people.push({ id: n.id, name: n.name, role: n.role, relationship: "never met", met: false, cites: [n.id] });
    // signals touching people (e.g. Karen wrote in) refresh last contact
    for (const s of signals.filter((s) => s.account === acc.id)) for (const p of people) if (p.met && s.summary.includes(p.name.split(" ").pop())) {
      if (!p.last_contact || s.dated > p.last_contact) { p.last_contact = s.dated; p.cites.push(s.id); }
    }
    const person = (name) => people.find((p) => p.name === name || p.name.endsWith(name));
    const users = data("users.json")?.users || [];
    for (const p of people) {
      const u = users.find((u) => u.name === p.name);
      if (u) { p.platform = { last_sign_in: u.last_sign_in, sign_ins_90d: u.sign_ins_last_90_days }; p.cites.push(pref("users.json")); }
    }

    // ---------- Q1: book with receipts ----------
    const deals = [];
    const dbf = Object.fromEntries(morning.deals.filter((d) => d.account === acc.id).map((d) => [d.deal, d]));
    for (const o of acc.opportunities) {
      const d = { id: o.id, title: o.title, stage: o.stage, blocker: o.blocker, evidence: o.evidence, cites: [o.id, ...o.evidence], contracted: null, backed: 0, at_risk: 0, claimed: [], basis: [] };
      if (/renew/i.test(o.title) && annual) {
        d.contracted = annual;
        d.cites.push(pref("contract.txt"));
        if (forceLog) {
          const op = forceLog.summary.filter((f) => f.operational), idle = forceLog.summary.filter((f) => !f.operational);
          const opDocks = op.reduce((s, f) => s + f.docks, 0), idleDocks = idle.reduce((s, f) => s + f.docks, 0);
          d.backed = opDocks * perDock; d.at_risk = idleDocks * perDock;
          const c1 = calc("renewal_backed", `Backed renewal: ${money(d.backed)}`, d.backed, `${op.map((f) => `${f.force} ${f.docks}`).join(" + ")} = ${opDocks} docks at forces flying live missions (${forceLog.file}) × ${money(perDock)} per dock`, [forceLog.file, `calc:${acc.id}:per_dock`, ...acc.facts.filter((f) => f.status === "verified").map((f) => f.id)]);
          const c2 = calc("renewal_at_risk", `Renewal at risk: ${money(d.at_risk)}`, d.at_risk, `${idle.map((f) => `${f.force} ${f.docks}`).join(" + ")} = ${idleDocks} docks with zero live missions in ${forceLog.months.length} months (${forceLog.file}) × ${money(perDock)}`, [forceLog.file, `calc:${acc.id}:per_dock`, "rc_appetite_2", "km_others_2"].filter((x) => E[x]));
          d.basis.push(c1, c2);
        } else {
          const reg = tiers.regular.length;
          d.backed = reg * perDock; d.at_risk = (devices.length - reg) * perDock;
          d.basis.push(calc("renewal_backed", `Backed renewal: ${money(d.backed)}`, d.backed, `${reg} docks in regular use (${tiers.regular.join(", ")}) × ${money(perDock)} per dock`, [`calc:${acc.id}:tiers`, `calc:${acc.id}:per_dock`]));
          d.basis.push(calc("renewal_at_risk", `Renewal at risk: ${money(d.at_risk)}`, d.at_risk, `${tiers.light.length} light-use docks + ${tiers.none.length} idle docks × ${money(perDock)}. Light use averages under 4 flights a month — hard to defend to a finance team asking for cost by plant.`, [`calc:${acc.id}:tiers`, `calc:${acc.id}:per_dock`]));
        }
      }
      if (o.worth_up_to != null) d.worth_up_to = o.worth_up_to;
      for (const fid of o.evidence) { const f = acc.facts.find((x) => x.id === fid); if (f && f.status === "claim") d.claimed.push({ text: f.text, by: f.said_by, id: f.id }); }
      if (dbf[o.id]) { d.debrief = dbf[o.id]; d.cites.push(dbf[o.id].id); }
      deals.push(d);
    }
    // deals only the debrief knows about (never heard of in discovery)
    for (const d of Object.values(dbf)) if (!deals.find((x) => x.id === d.deal)) deals.push({ id: d.deal, title: d.title, stage: "unknown — never heard of", debrief: d, cites: [d.id], backed: 0, at_risk: 0, claimed: [], basis: [], unknown: true });

    const offers = (acc.offers || []).map((o) => ({ ...o, cites: [o.id] }));
    const won = offers.filter((o) => o.status === "won"), open = offers.filter((o) => o.status === "open");
    const claimsApart = [];
    for (const f of acc.facts.filter((f) => f.status === "claim")) {
      const m = f.text.match(/(\d+)[- ]dock/); const big = f.text.match(/([\d.]+) million/);
      claimsApart.push({ id: f.id, text: f.text, by: f.said_by, implied: m && perDock ? +m[1] * perDock : big ? +big[1] * 1e6 : null, impliedNote: m && perDock ? `${m[1]} docks × ${money(perDock)} list — if it were real` : big ? "as stated, no working supplied" : null });
    }
    for (const f of acc.facts.filter((f) => f.status === "told" && /(\d+)[- ]dock/.test(f.text))) {
      const m = f.text.match(/(\d+)[- ]dock/);
      claimsApart.push({ id: f.id, text: f.text, by: f.said_by, implied: perDock ? +m[1] * perDock : null, impliedNote: `${m[1]} docks × ${money(perDock)} list; told, nothing in writing`, told: true });
    }
    const backedTotal = deals.reduce((s, d) => s + (d.backed || 0), 0) + won.reduce((s, o) => s + o.value, 0);
    const atRiskTotal = deals.reduce((s, d) => s + (d.at_risk || 0), 0);
    const book = {
      backed: backedTotal, at_risk: atRiskTotal, open_offers: open.reduce((s, o) => s + o.value, 0),
      backedCalc: calc("book_backed", `Book you can back: ${money(backedTotal)}`, backedTotal, [...deals.filter((d) => d.backed).map((d) => `${d.id} ${money(d.backed)}`), ...won.map((o) => `${o.id} ${money(o.value)} (won)`)].join(" + "), [...deals.filter((d) => d.backed).flatMap((d) => d.basis.slice(0, 1)), ...won.map((o) => o.id)]),
      deals, offers, claimsApart,
    };

    // ---------- Q2: power map ----------
    const power = deals.map((d) => {
      const roles = [];
      const add = (role, name, why, cites) => {
        const p = name && person(name);
        roles.push({ role, name: name || null, who: p ? `${p.name}` : name || "Unknown", role_title: p?.role, stance: p ? p.relationship : name ? "unknown" : "gap", met: p ? p.met : false, why, cites: [...(p?.cites?.slice(0, 1) || []), ...cites].filter((c) => E[c]) });
      };
      const db = d.debrief;
      if (db?.decides) add("Decides", db.decides, "Named by the debrief", [db.id]);
      if (db?.pays) add("Pays", db.pays, db.pays === db.decides ? "Same person signs off the money" : "Named by the debrief", [db.id]);
      // A: money is per force (rc_funding_2 / hd_calloff_2)
      if (acc.facts.some((f) => f.id === "rc_funding_2") && /renew|tender|westmere/i.test(d.title)) add("Pays (also)", null, "No pooled budget: each force's finance officer must approve its call-off. Only Metro Central's (Ewan Brooks) is known.", ["rc_funding_2", "hd_calloff_2"]);
      for (const p of people.filter((p) => p.met)) {
        if ((/drone unit/i.test(p.role) && /westmere|renew|tender/i.test(d.title)) || (/plant manager/i.test(p.role) && /renew|idle|case/i.test(d.title))) add("Uses", p.name, `${p.role}`, [p.id, ...(d.evidence || []).filter((e) => acc.facts.find((f) => f.id === e && f.said_by === p.name))]);
      }
      if (db?.came_up_with) for (const n of db.came_up_with) add("Knows about it", n, "The deal came up with this person in the debrief", [db.id]);
      // blockers: people named in facts as not signed off / cautious
      if (/tarn|renew/i.test(d.title) && E.km_others_2 && acc.id === "A") {
        add("Could block", "Fatima Osei", "Tarn Valley DPO has not signed off the DPIA", ["km_others_2", "fo_dpia_0"]);
        add("Could block", null, "Norwold's chief constable — cautious after a local privacy row (name not on file)", ["km_others_2"]);
      }
      if (/tender/i.test(d.title)) add("Could block", "Hannah Doyle", "Procurement lead: anything larger than the first order goes through a formal process", [pref("calls/2025-12-16_pilot_review.txt"), "dbf_hannah_doyle"]);
      if (acc.id === "B" && /renew/i.test(d.title)) {
        add("Champion (signed last order)", "Stefan Roy", "Signed the 2026 order from the group security budget; 0 platform sign-ins in 90 days", [pref("contract.txt"), pref("users.json")]);
        add("Could block", "Nadia Rahman", "Group Finance asked for cost per plant before any renewal is raised; unverified €1.2M savings claim", [pref("emails/2026-10-08_finance_mailbox.txt"), "sr_roi_0"]);
      }
      const champ = people.filter((p) => p.met && (p.relationship === "warm" || p.relationship === "ally"));
      for (const c of champ) if (!roles.find((r) => r.name === c.name)) if (/westmere|renew/i.test(d.title)) add("Champion", c.name, `${c.relationship} — strongest relationship on the account`, [c.id]);
      // de-dup by role+who
      const seen = new Set();
      return { deal: d.id, title: d.title, roles: roles.filter((r) => { const k = r.role + r.who; if (seen.has(k)) return false; seen.add(k); return true; }) };
    });

    // ---------- signals for this account ----------
    const accSignals = signals.filter((s) => s.account === acc.id);
    const requests = rec["requests.csv"] ? parseCSV(rec["requests.csv"].text) : [];
    // fold in request rows delivered by signals (they say "Row to add")
    for (const s of accSignals) for (const r of s.records || []) if (r.kind === "request") for (const row of parseCSV(r.text)) if (!requests.find((x) => x.request_id === row.request_id)) requests.push({ ...row, _signal: s.id });

    // ---------- Q4: risks (computed first; moves react to them) ----------
    const risks = [];
    const risk = (o) => risks.push({ account: acc.id, ...o, cites: o.cites.filter((c) => E[c]) });
    for (const s of accSignals) {
      const text = s.summary + " " + (s.records || []).map((r) => r.text).join(" ");
      const ev5 = text.match(/(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December)/);
      const eventDate = ev5 ? new Date(`${ev5[1]} ${ev5[2]} ${s.dated.slice(0, 4)} UTC`).toISOString().slice(0, 10) : null;
      if (/this week|urgent/i.test(text)) {
        const due = fridayOf(s.dated);
        risk({ id: `risk:${s.id}`, level: "red", type: "Deadline", title: `${s.title.split(": ").pop()} — unanswered`, detail: `${s.summary}${eventDate ? ` Hard date: ${fmtDate(eventDate)}.` : ""}`, turns_bad: due, turns_bad_why: `Asked for a written answer "this week" (by ${fmtDate(due)})${eventDate ? `; the event itself is ${fmtDate(eventDate)}` : ""}`, deals: deals.filter((d) => /westmere|renew/i.test(d.title)).map((d) => d.id), cites: [s.id, ...(s.records || []).map((r) => r.path && `${acc.id}/${r.path.replace(/^[AB]\//, "")}`)].filter(Boolean) });
      }
      if (/moving on|leaves|leaving|moving to another role/i.test(text)) {
        const m = text.match(/in (January|February|March|the new year)/i);
        const when = m ? (/new year|january/i.test(m[1]) ? `${+s.dated.slice(0, 4) + 1}-01-01` : null) : null;
        risk({ id: `risk:${s.id}`, level: "red", type: "Champion leaving", title: s.title.split(": ").pop(), detail: `${s.summary} The renewal decision is due ${termEnds ? fmtDate(termEnds) : "after he goes"} — after he leaves.`, turns_bad: when, turns_bad_why: "He hands over in January; no successor named; every call on file is with him alone", deals: deals.filter((d) => !d.unknown).map((d) => d.id), cites: [s.id, pref("profile.json"), pref("calls_index.json")] });
      }
    }
    if (termEnds) {
      const dleft = days(asOf, termEnds);
      const db = dbf[deals.find((d) => /renew/i.test(d.title))?.id];
      const deciderMet = db ? person(db.decides)?.met : true;
      const orderBy = addDays(termEnds, -30);
      risk({ id: `risk:${acc.id}:renewal`, level: dleft < 120 && (!deciderMet || deals.find((d) => /renew/i.test(d.title))?.at_risk) ? "red" : "amber", type: "Renewal", title: `Contract ends ${fmtDate(termEnds)} — no automatic renewal (${dleft} days)`, detail: `${money(annual)} a year. A new order is needed before the term ends.${db ? ` Decider per debrief: ${db.decides}${deciderMet ? "" : " — never met"}.` : ""} ${money(book.at_risk)} of it is not backed by usage.`, turns_bad: orderBy, turns_bad_why: "Allow ~30 days for a public/finance order to be raised before the term ends", deals: deals.filter((d) => /renew/i.test(d.title)).map((d) => d.id), cites: [pref("contract.txt"), pref("profile.json"), `calc:${acc.id}:renewal_at_risk`, db?.id].filter(Boolean) });
    }
    if (forceLog) for (const f of forceLog.summary.filter((f) => !f.operational)) risk({ id: `risk:${acc.id}:force:${f.force}`, level: "amber", type: "Not used", title: `${f.force}: ${f.docks} docks, 0 live missions in ${f.series.length} months`, detail: `${f.training} training flights only. ${money(f.docks * perDock)} of the renewal rests on docks this force does not use.`, turns_bad: termEnds && addDays(termEnds, -30), turns_bad_why: "Each force's finance officer approves its own call-off at renewal", deals: deals.filter((d) => /renew|tarn/i.test(d.title)).map((d) => d.id), cites: [forceLog.file, "rc_appetite_2", "km_others_2", "rc_funding_2"] });
    if (forceLog) for (const f of forceLog.summary.filter((f) => f.operational && f.series.length >= 2)) {
      const [a, b] = f.series.slice(-2);
      if (b.docks_live < a.docks_live * 0.6) risk({ id: `risk:${acc.id}:decline:${f.force}`, level: "amber", type: "Usage falling", title: `${f.force}: docks flying fell ${a.docks_live} → ${b.docks_live} (${a.month} → ${b.month})`, detail: `Of ${f.docks} docks. Nobody on file at ${f.force} has been asked why.`, turns_bad: termEnds && addDays(termEnds, -30), turns_bad_why: "Falling use is what a finance officer sees at call-off", deals: deals.filter((d) => /renew|westmere|tender/i.test(d.title)).map((d) => d.id), cites: [forceLog.file] });
    }
    if (!forceLog && tiers.light.length >= tiers.regular.length && tiers.light.length) risk({ id: `risk:${acc.id}:light`, level: "amber", type: "Usage thin", title: `${tiers.light.length} of ${devices.length} docks fly under 4 times a month`, detail: `Only ${tiers.regular.join(", ")} fly regularly; ${tiers.none.join(", ") || "none"} idle. "Flying" in the official story means at least once — a per-plant quote will show the difference.`, turns_bad: termEnds && addDays(termEnds, -30), turns_bad_why: "Finance asked for cost per plant before renewal", deals: deals.filter((d) => /renew/i.test(d.title)).map((d) => d.id), cites: [`calc:${acc.id}:tiers`, pref("flights.csv"), ...acc.facts.filter((f) => /flying/i.test(f.text) && f.status === "claim").map((f) => f.id)] });
    // battery issue ignored
    const battDocks = Object.entries(batt).filter(([, n]) => n >= 10).sort((a, b) => b[1] - a[1]);
    if (battDocks.length) {
      const em = pw.find((r) => r.kind === "email" && /batter/i.test(r.text || "") && /No reply/i.test(r.text || ""));
      const hasEvent = risks.find((r) => r.type === "Deadline");
      risk({ id: `risk:${acc.id}:battery`, level: em ? "red" : "amber", type: "Product", title: `Battery health warnings: ${battDocks.map(([d, n]) => `${d} ×${n}`).join(", ")}`, detail: `${battDocks.length === 2 ? "Both" : "These"} are among the busiest docks (${battDocks.map(([d]) => `${d}: ${byDock[d]} flights`).join(", ")}).${em ? ` The customer's email about batteries (${em.path}) has had no reply for ${days(em.path.match(/\d{4}-\d{2}-\d{2}/)[0], asOf)} days.` : ""}`, turns_bad: hasEvent?.turns_bad || null, turns_bad_why: hasEvent ? "A failed aircraft on the day of the public event is the worst case" : "", deals: deals.filter((d) => /westmere|renew/i.test(d.title)).map((d) => d.id), cites: [pref("device_events.csv"), pref("flights.csv"), em && pref(em.path)].filter(Boolean) });
    }
    // offline docks / connection
    for (const [d, n] of Object.entries(offline)) risk({ id: `risk:${acc.id}:offline:${d}`, level: "amber", type: "Product", title: `${d} went offline for days ${n} times`, detail: `${conn[d] || 0} connection drops in total. ${requests.filter((r) => /offline/i.test(r.summary)).map((r) => `${r.request_id}: ${r.status} — ${r.summary}`).join(" ")}`, turns_bad: termEnds && addDays(termEnds, -30), turns_bad_why: "A dock that cannot fly is a line finance will cut from a per-plant quote", deals: deals.filter((d) => /renew/i.test(d.title)).map((d) => d.id), cites: [pref("device_events.csv"), pref("requests.csv"), ...requests.filter((r) => /offline/i.test(r.summary)).map((r) => r.request_id)] });
    // open requests with no owner
    for (const r of requests.filter((r) => /open|pending/i.test(r.status) && !r._signal)) {
      const age = days(r.opened, asOf);
      const noOwner = !r.owner;
      risk({ id: `risk:${acc.id}:req:${r.request_id}:${r.opened}`, level: noOwner && age > 30 ? "red" : noOwner ? "amber" : "amber", type: "Unanswered", title: `${r.request_id !== "(none)" ? r.request_id + " — " : ""}${r.from}: ${r.summary.split(".")[0]}`, detail: `${r.summary} Open ${age} days${noOwner ? ", no owner" : `, owner: ${r.owner}`}.`, turns_bad: r._signal ? fridayOf(r.opened) : addDays(r.opened, 30) < asOf ? asOf : addDays(r.opened, 30), turns_bad_why: age > 30 ? "Already past a reasonable reply window" : "30 days without a reply", deals: [], cites: [r._signal || pref("requests.csv"), E[r.request_id] ? r.request_id : null].filter(Boolean) });
    }
    // people going cold
    for (const p of people.filter((p) => p.met && p.last_contact)) {
      const gap = days(p.last_contact, asOf);
      if (gap > 45) risk({ id: `risk:${acc.id}:cold:${p.id}`, level: gap > 90 ? "red" : "amber", type: "Going cold", title: `${p.name}: no contact for ${gap} days`, detail: `${p.role}, ${p.relationship}. Last contact ${fmtDate(p.last_contact)}.${p.platform ? ` Platform: ${p.platform.sign_ins_90d} sign-ins in 90 days.` : ""}`, turns_bad: addDays(p.last_contact, 90), turns_bad_why: "90 days of silence", deals: [], cites: p.cites });
      else if (p.platform && p.platform.sign_ins_90d === 0) risk({ id: `risk:${acc.id}:disengaged:${p.id}`, level: "amber", type: "Going cold", title: `${p.name} has not used the platform in 90 days`, detail: `Account administrator; last sign-in ${p.platform.last_sign_in}. He reports the programme to the board without looking at it.`, turns_bad: null, deals: [], cites: p.cites });
    }
    // claims carrying deals
    for (const d of deals) for (const c of d.claimed || []) risk({ id: `risk:${acc.id}:claim:${d.id}:${c.id}`, level: "amber", type: "Unverified", title: `${d.title} leans on a claim`, detail: `“${c.text}” — ${c.by}. Status: claim; nothing on file backs it.`, turns_bad: null, deals: [d.id], cites: [c.id, d.id] });
    for (const c of claimsApart.filter((c) => !c.told && !deals.some((d) => d.claimed?.find((x) => x.id === c.id)))) risk({ id: `risk:${acc.id}:claim:${c.id}`, level: "amber", type: "Unverified", title: `Claim in circulation: “${c.text}”`, detail: `${c.by}. Nothing on file backs it. Do not quote it in a proposal or case study.`, turns_bad: null, deals: [], cites: [c.id] });
    const lvl = { red: 0, amber: 1, green: 2 };
    risks.sort((a, b) => lvl[a.level] - lvl[b.level] || String(a.turns_bad || "9").localeCompare(String(b.turns_bad || "9")));

    // ---------- Q3: next best actions ----------
    const moves = [];
    const commercial = team.find((t) => t.id === profile.flytbase_side?.commercial_owner);
    const se = team.find((t) => /solutions engineer/i.test(t.role));
    const lead = team.find((t) => /lead customer success/i.test(t.role));
    const gtm = team.find((t) => /gtm/i.test(t.role));
    const owner = (t) => (t ? { name: t.name, cite: `team:${t.id}` } : { name: "You (CSM)", cite: pref("profile.json") });
    const you = { name: "You (CSM)", cite: pref("profile.json") };
    const move = (o) => moves.push({ account: acc.id, ...o, cites: [...new Set(o.cites)].filter((c) => E[c]) });
    const dealValue = (id) => { const d = deals.find((x) => x.id === id); return d?.contracted || d?.debrief?.debrief_value_usd || 0; };

    for (const s of accSignals) {
      const text = s.summary + " " + (s.records || []).map((r) => r.text).join(" ");
      if (/this week|urgent/i.test(text)) {
        const wonO = won.filter((o) => /training|support/i.test(o.title));
        move({ id: `mv:${s.id}`, title: `Reply in writing to ${s.summary.match(/^([A-Z][\w.]* ?[A-Z]\w+ [A-Z]\w+|[A-Z]\w+ [A-Z]\w+)/)?.[0] || "the requester"}: training dates + named on-day cover`, why: `${s.summary} You already won ${wonO.map((o) => `${o.title} (${money(o.value)})`).join(" and ")} — deliver them, in writing, with a named contact for the day. ${battDocks.length ? `Fix the battery issue on ${battDocks.map(([d]) => d).join(" & ")} before the event.` : ""}`, owner: you, with: [owner(se)], due: fridayOf(s.dated), deal: deals.find((d) => /westmere/i.test(d.title))?.id || deals[0]?.id, value: wonO.reduce((s, o) => s + o.value, 0) + dealValue(deals.find((d) => /renew/i.test(d.title))?.id) * 0.5, urgency: 3, cites: [s.id, ...wonO.map((o) => o.id), `risk:${acc.id}:battery`].concat(battDocks.length ? [pref("device_events.csv")] : []) });
      }
      if (/moving on|leaves|leaving|another role/i.test(text)) {
        const db = dbf[deals.find((d) => /renew/i.test(d.title))?.id];
        move({ id: `mv:${s.id}`, title: `Get the renewal proposal to Rhys Calder before he hands over — with ${db?.unlock_evidence?.join(" + ") || "the usage evidence"}`, why: `${db?.unlock || ""} He leaves in January and "anything we have agreed stands" — so get it agreed now, and ask him in the same note to name his successor and introduce the procurement lead (Hannah Doyle per debrief) and each force's finance contact.`, owner: owner(commercial), with: [you], due: addDays(asOf, 9), deal: db?.deal, value: dealValue(db?.deal), urgency: 2.5, cites: [s.id, db?.id, ...(db?.unlock_evidence || []), "rc_funding_2", "dbf_hannah_doyle"].filter(Boolean) });
      }
      if (!/this week|urgent|moving on|leaves|another role/i.test(text)) move({ id: `mv:${s.id}`, title: `Act on: ${s.title}`, why: s.summary, owner: you, due: addDays(s.dated, 3), deal: null, value: 0, urgency: 1.5, cites: [s.id] });
    }
    // unblock each deal (debrief knows the blocker / decider)
    for (const d of deals.filter((d) => d.debrief && !d.unknown)) {
      const db = d.debrief;
      if (db.unlock) continue; // handled above (renewal proposal)
      if (!db.blocker) continue;
      const decider = person(db.decides);
      const bridge = people.filter((p) => p.met).sort((a, b) => ["ally", "warm", "neutral", "guarded"].indexOf(a.relationship) - ["ally", "warm", "neutral", "guarded"].indexOf(b.relationship))[0];
      let title, why, who = you, due = addDays(asOf, 14), cites = [db.id, d.id];
      if (/data-flow|documents/i.test(db.blocker)) {
        const req = requests.find((r) => /document/i.test(r.summary) && /open/i.test(r.status));
        title = `Send ${db.decides} the data-flow documents for the DPIA${req ? ` — and close ${req.request_id}` : ""}`;
        why = `Blocker: ${db.blocker} ${req ? `${req.request_id} (a document request from "a contact at one of the forces") has been open since ${fmtDate(req.opened)} with no owner and was chased — very likely the same request. ` : ""}Do NOT promise a go-live date (that is what put this deal at risk).`;
        who = owner(lead); due = addDays(asOf, 2); cites.push(req?.request_id, pref("requests.csv"), "fo_dpia_0", "km_others_2");
      } else if (/cost per flight|helicopter/i.test(db.blocker)) {
        const wm = forceLog?.summary.find((f) => /westm/i.test(f.force));
        title = `Build cost-per-flight vs helicopter-hour for ${db.decides}`;
        why = `Blocker: ${db.blocker} Inputs on file: ${wm ? `${wm.live_missions} Westmere live missions May–Oct` : `${flights.length} flights`} (${forceLog?.file || "flights.csv"}), ${money(perDock)}/dock/year, Karen's 12-vs-40-minute finds (km_value_2). Ask Ewan for the helicopter hourly cost — do not pitch extra docks until he has the number (pitching early put this deal at risk).`;
        who = owner(gtm); due = addDays(asOf, 16); cites.push("km_value_2", forceLog?.file, `calc:${acc.id}:per_dock`, "dbf_door_ewan");
      } else if (/costed operating model|specification/i.test(db.blocker)) {
        title = `Offer ${db.decides} a costed operating model for the tender spec (via Rhys / Karen)`;
        why = `Blocker: ${db.blocker} ${decider?.met ? "" : `${db.decides} has never been met — the procurement lead attended the Dec 2025 pilot review and asked to be kept informed; nobody owned that.`} Staffing data for the model: km_staff_2. Payer per debrief: ${db.pays}.`;
        who = owner(commercial); due = addDays(asOf, 21); cites.push(pref("calls/2025-12-16_pilot_review.txt"), "km_staff_2", "rc_tender_0", "dbf_hannah_doyle");
      } else if (/savings/i.test(db.blocker)) {
        const fin = pw.find((r) => /finance/i.test(r.path));
        title = `Answer Group Finance with a per-plant renewal quote and ask for a meeting with ${db.decides}`;
        why = `Blocker: ${db.blocker} Finance asked on ${fin ? fin.path.match(/\d{4}-\d{2}-\d{2}/)[0] : "8 Oct"} for cost per plant — unanswered. Send ${money(perDock)} × ${devices.length} docks, with real usage by dock (${tiers.regular.length} regular, ${tiers.light.length} light, ${tiers.none.length} idle) rather than the unverified €1.2M figure. Tell Stefan Roy first, so it does not land as going around him.`;
        who = owner(commercial); due = addDays(asOf, 3); cites.push(fin && pref(fin.path), `calc:${acc.id}:tiers`, `calc:${acc.id}:per_dock`, "sr_roi_0", "stefan_roy");
      } else { title = `Clear blocker on ${d.title}`; why = db.blocker; }
      if (!decider?.met && bridge) why += ` Route in: ${bridge.name} (${bridge.relationship}).`;
      move({ id: `mv:unblock:${d.id}`, title, why, owner: who, with: [], due, deal: d.id, value: dealValue(d.id), urgency: days(asOf, due) <= 3 ? 2.2 : 1.4, cites });
    }
    // unanswered requests not already covered
    for (const r of requests.filter((r) => /open|pending/i.test(r.status))) {
      if (moves.some((m) => m.why.includes(r.request_id) && r.request_id !== "(none)") || r._signal) continue;
      if (/finance/i.test(r.from) && moves.some((m) => /Group Finance/.test(m.title))) continue;
      if (/case study/i.test(r.summary)) { move({ id: `mv:req:casestudy`, title: "Agree with Stefan Roy what the case study can stand on: savings working + one plant willing to be quoted", why: `${r.summary} Open ${days(r.opened, asOf)} days. Do not publish the €1.2M headline (claim, no working). Offer a usage-based draft from flights.csv instead — and use it to open a conversation with Finance and Insurance (debrief: the sister-company and insurance-discount deals come up with Nadia Rahman / Julian Tate).`, owner: you, with: [owner(gtm)], due: addDays(asOf, 7), deal: "b_case_study", value: 0.2 * annual, urgency: 1.1, cites: [pref("requests.csv"), "sr_roi_0", pref("emails/2026-09-22_stefan_case_study.txt"), "dbf_b_case_study", "dbf_door_stefan"] }); continue; }
      move({ id: `mv:req:${r.request_id}:${r.opened}`, title: `${r.request_id === "(none)" ? "Reply" : `Close out ${r.request_id}`}: ${r.from} — ${r.summary.split(".")[0]}`, why: `${r.summary} Open ${days(r.opened, asOf)} days.`, owner: /pending customer/i.test(r.status) ? owner(se) : you, due: addDays(asOf, 5), deal: deals.find((d) => /renew/i.test(d.title))?.id, value: 0.15 * dealValue(deals.find((d) => /renew/i.test(d.title))?.id), urgency: 1.2, cites: [pref("requests.csv"), E[r.request_id] ? r.request_id : null].filter(Boolean) });
    }
    // open offers -> pitch when ready
    for (const o of open) {
      const p = person(o.pitch_to);
      move({ id: `mv:offer:${o.id}`, title: `Ask ${o.pitch_to} why she changed the night-alert recipients — then position ${o.title}`, why: `Open offer ${money(o.value)}. ${p ? `${p.name} is ${p.relationship}; ` : ""}she asked support to send night alerts to more than one person (FB-10944) and nobody asked why. Learn the problem before pitching (pitching early put the idle-plants deal at risk).`, owner: you, due: addDays(asOf, 10), deal: o.id, value: o.value, urgency: 1.0, cites: [o.id, "beatriz_alonso", "FB-10944", pref("emails/2026-09-18_beatriz_alerts.txt"), "dbf_b_idle_plants"] });
    }
    // usage promise broken (A) — monthly summary
    const summaries = (data("mail_log.json")?.mail || []).filter((m) => /usage summary/i.test(m.subject || ""));
    if (summaries.length && forceLog) move({ id: `mv:${acc.id}:summary`, title: "Restart the monthly usage summary — split by force this time", why: `Promised monthly; last sent ${summaries.at(-1).date}. Rhys asked for it by force (2 Jun) and the board "loves a chart" (FR-011). The cleaned force log now makes that possible: it is also the renewal evidence.`, owner: you, due: addDays(asOf, 12), deal: deals.find((d) => /renew/i.test(d.title))?.id, value: 0.1 * annual, urgency: 1, cites: [pref("mail_log.json"), pref("calls/2026-06-02_check_in.txt"), forceLog.file] });
    // never-met deciders -> intro
    for (const n of people.filter((p) => !p.met)) {
      const ds = Object.values(dbf).filter((d) => d.decides === n.name || d.pays === n.name || d.came_up_with?.includes(n.name));
      if (!ds.length || moves.some((m) => m.title.includes(n.name))) continue;
      move({ id: `mv:intro:${n.id}`, title: `Get introduced to ${n.name} (${n.role})`, why: `Named in the debrief for: ${ds.map((d) => d.title).join("; ")}. Never met.`, owner: you, due: addDays(asOf, 14), deal: ds[0].deal, value: ds.reduce((s, d) => s + (dealValue(d.deal) || 0), 0), urgency: 0.9, cites: [n.id, ...ds.map((d) => d.id)] });
    }
    // rank: value at stake (log) × urgency × time pressure
    for (const m of moves) {
      const dleft = Math.max(0, days(asOf, m.due));
      m.score = +(Math.log10(10 + (m.value || 0)) * m.urgency * (1 + 7 / (dleft + 1))).toFixed(2);
      m.days_left = dleft;
    }
    moves.sort((a, b) => b.score - a.score);
    moves.forEach((m, i) => (m.rank = i + 1));

    // ---------- Q5: gaps ----------
    const gaps = [];
    const gap = (o) => gaps.push({ account: acc.id, ...o, cites: o.cites.filter((c) => E[c]) });
    const whoFor = (t) => {
      if (/dock sits at which force|install sheets/i.test(t)) return { who: "FlytBase field team (holds the install sheets)", cite: pref("calls/2026-04-28_install_close.txt") };
      if (/which dock sits at which plant|install list/i.test(t)) return { who: "Stefan Roy's deputy — active on the platform as U02 (38 sign-ins / 90 days)", cite: pref("users.json") };
      if (/procurement lead/i.test(t)) return { who: "Rhys Calder or Insp. Karen Mbeki (both on the Dec 2025 call); debrief names her Hannah Doyle", cite: "dbf_hannah_doyle" };
      if (/finance/i.test(t) && acc.id === "A") return { who: "FlytBase Accounts — Schedule 2 holds the four billing contacts; Ewan Brooks for Metro Central", cite: pref("invoices.json") };
      if (/finance/i.test(t)) return { who: "Group Finance shared mailbox (wrote 8 Oct); debrief names Nadia Rahman", cite: "dbf_nadia_rahman" };
      if (/deputy/i.test(t)) return { who: "Stefan Roy, or the platform (U02 is the deputy's admin login)", cite: pref("users.json") };
      if (/group IT/i.test(t)) return { who: "Support desk via FB-10903; debrief names Owen Fitch", cite: "dbf_owen_fitch" };
      if (/plant other than/i.test(t)) return { who: "Beatriz Alonso (Plant 7) and the deputy", cite: "beatriz_alonso" };
      if (/Metro Central, Tarn Valley or Norwold/i.test(t)) return { who: "Insp. Karen Mbeki (warm), Ewan Brooks, Fatima Osei — all met this morning", cite: "karen_mbeki" };
      return { who: "Unknown", cite: pref("profile.json") };
    };
    for (const t of profile.not_on_file || []) {
      const w = whoFor(t);
      gap({ id: `gap:${acc.id}:${gaps.length}`, what: t, why: /dock|install/i.test(t) ? "Without it you cannot say which force/plant uses what — the renewal value per force or plant cannot be proved." : /finance|procurement/i.test(t) ? "The people who sign the renewal are not on file." : "Single-threaded account: one contact holds all the knowledge.", who: w.who, cites: [pref("profile.json"), w.cite] });
    }
    for (const r of requests.filter((r) => /document/i.test(r.summary) && /open/i.test(r.status))) gap({ id: `gap:${acc.id}:doc`, what: `What ${r.request_id} asks for, and who sent it`, why: "Likely the DPIA documents blocking Tarn Valley (debrief) — unconfirmed until someone reads the ticket.", who: "Support desk (holds the requester's details)", cites: [pref("requests.csv"), r.request_id, "dbf_a_tarn"] });
    for (const c of claimsApart) {
      const w = /stadium/i.test(c.text) ? ["Insp. Karen Mbeki — her unit would fly them; Rhys never brought her in", "karen_mbeki"] : /keen|forces/i.test(c.text) ? ["Fatima Osei (Tarn Valley) and Norwold directly — the flight log already says otherwise", "fatima_osei"] : /budget/i.test(c.text) ? ["Each force's finance officer — Ewan Brooks for Metro Central (no pooled budget, rc_funding_2)", "ewan_brooks"] : /tender/i.test(c.text) ? ["Hannah Doyle, procurement lead (debrief) — spec, timetable, evaluation method", "dbf_hannah_doyle"] : /officers|operators/i.test(c.text) ? ["Insp. Karen Mbeki (her own unit)", "karen_mbeki"] : /ROI|saved/i.test(c.text) ? ["Group Finance — Nadia Rahman (debrief); Stefan promised the breakdown in July, never sent", "dbf_nadia_rahman"] : /plants are flying/i.test(c.text) ? ["Already testable: flights.csv shows how often each dock flies", pref("flights.csv")] : [c.by, c.id];
      gap({ id: `gap:${acc.id}:claim:${c.id}`, what: `Is it true: “${c.text}”`, why: c.implied ? `${c.impliedNote}: ${money(c.implied)} not counted in the book.` : "Status is claim/told; nothing on file backs it.", who: w[0], cites: [c.id, w[1]] });
    }
    for (const d of deals.filter((d) => d.unknown)) gap({ id: `gap:${acc.id}:deal:${d.id}`, what: `Is there a deal in “${d.title}”?`, why: "Never came up in discovery; the debrief says it exists.", who: d.debrief.came_up_with.join(", "), cites: [d.debrief.id] });
    if (signals.some((s) => s.account === acc.id && /successor/i.test(s.summary))) gap({ id: `gap:${acc.id}:successor`, what: "Who replaces Rhys Calder in January", why: "The renewal (and every open deal) runs through the programme office.", who: "Rhys Calder", cites: signals.filter((s) => /successor/i.test(s.summary)).map((s) => s.id) });
    if (forceLog?.issues.some((i) => /no row/.test(i.issue))) gap({ id: `gap:${acc.id}:forcelog`, what: forceLog.issues.filter((i) => /no row/.test(i.issue)).map((i) => i.issue.replace("; treated as unknown, not zero", "")).join("; "), why: "Missing month in the verified file — do not treat as zero use.", who: "Whoever compiles the force log (Rhys Calder's programme office)", cites: [forceLog.file] });

    // ---------- growth: upsell / cross-sell ----------
    const growth = [];
    for (const d of deals.filter((d) => !/renew/i.test(d.title))) growth.push({ id: d.id, title: d.title, stage: d.stage, kind: d.unknown ? "Undiscovered" : "Expansion", sizing: d.debrief?.debrief_value_usd ? `Debrief value $${d.debrief.debrief_value_usd.toLocaleString()}` : "No value on file", next: d.debrief?.blocker ? `Clear: ${d.debrief.blocker}` : d.debrief?.came_up_with ? `Ask ${d.debrief.came_up_with.join(" / ")}` : "Qualify", cites: d.cites });
    for (const o of offers) growth.push({ id: o.id, title: o.title, stage: o.status, kind: o.status === "won" ? "Won upsell — deliver" : o.status === "open" ? "Open upsell" : "Declined — revisit only with new evidence", sizing: money(o.value), next: o.status === "won" ? "Deliver and invoice" : o.status === "open" ? `Pitch to ${o.pitch_to} when the need is clear` : `Declined by ${o.pitch_to}`, cites: o.cites });
    for (const c of claimsApart) if (c.implied) growth.push({ id: c.id, title: c.text, stage: "claim", kind: "Unverified size", sizing: `${money(c.implied)} — not counted`, next: `Verify: ${c.by} said it`, cites: [c.id] });
    for (const fr of (S.feature_requests?.requests || []).filter((r) => r.raised_by_your_accounts?.some((x) => x.account === acc.id))) growth.push({ id: fr.id, title: `Feature lever: ${fr.title}`, stage: fr.status, kind: "Product lever", sizing: `${fr.mentions} mentions across customers`, next: `Raised by ${fr.raised_by_your_accounts.filter((x) => x.account === acc.id).map((x) => x.who).join(", ")} — tell them where it stands`, cites: [] });

    // ---------- timeline ----------
    const timeline = [
      ...(data("deal_history.json")?.history || []).map((h) => ({ date: h.date, what: h.what, detail: h.detail, cite: pref("deal_history.json") })),
      ...accSignals.map((s) => ({ date: s.dated, what: "Live event", detail: s.title, cite: s.id, live: true })),
    ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const keyDates = [
      ...risks.filter((r) => r.turns_bad).map((r) => ({ date: r.turns_bad, what: r.title, level: r.level, cite: r.id })),
      ...moves.slice(0, 5).map((m) => ({ date: m.due, what: `Due: ${m.title}`, level: "move", cite: m.id })),
      termEnds && { date: termEnds, what: "Contract term ends", level: "red", cite: pref("contract.txt") },
    ].filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));

    for (const r of risks) ev(r.id, { kind: "risk", account: acc.id, label: r.title, text: r.detail });
    for (const m of moves) ev(m.id, { kind: "move", account: acc.id, label: m.title, text: m.why });

    const red = risks.filter((r) => r.level === "red").length;
    out.push({
      id: acc.id, name: acc.name, currency: profile.currency, symbol: cur, sector: profile.sector, official_story: acc.official_story,
      what_they_bought: profile.what_they_bought, term_ends: termEnds, days_to_renewal: termEnds ? days(asOf, termEnds) : null, annual, perDock,
      health: { red, amber: risks.filter((r) => r.level === "amber").length, label: red >= 3 ? "At risk" : red ? "Needs attention" : "Healthy" },
      book, power, moves, risks, gaps, growth, people, usage, forceLog, timeline, keyDates, signals: accSignals.map((s) => s.id),
      notes: notes.filter((n) => !n.account || n.account === acc.id),
    });
  }

  return {
    asOf, today, latestSignal, accounts: out, evidence: E, morning: { book_usd: morning.book_usd, best_reply_rate: morning.best_reply_rate },
    changes: store.changes || [], meta: store.meta || {}, fetchedAt: store.fetchedAt || {}, pendingNotes: store.pendingNotes || [],
  };
}
