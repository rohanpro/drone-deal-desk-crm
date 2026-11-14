// "Ask Flightdeck": answers team questions in chat, grounded only in the CRM's own answers.
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise a built-in rule-based coach answers.
let Anthropic = null;
try { Anthropic = (await import("@anthropic-ai/sdk")).default; } catch { console.warn("[assistant] @anthropic-ai/sdk not installed — using the built-in coach"); }

const MODEL = process.env.ASSISTANT_MODEL || "claude-opus-5-5";
let client = null;
const hasKey = () => !!Anthropic && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const getClient = () => (client ||= new Anthropic());

const SYSTEM = `You are Flightdeck's deal coach, inside the CRM of a B2B company that sells drone-in-a-box SaaS (docks, aircraft and the software platform) to police forces and industrial groups.
Your readers are a mixed team: customer success, account executives, solutions engineers, support, marketing and their sales manager. Many are not technical.

How to answer:
- Plain English, short. Lead with the answer in one or two sentences, then at most 4 bullets. No jargon, no internal field names.
- Use ONLY the CRM snapshot in the next system block. Never invent a person, number, date or ticket. If the snapshot does not say, say so and name who could find out (from the snapshot's unknowns).
- After any fact or number, cite the source id in square brackets exactly as it appears in the snapshot's "cites" lists, e.g. [km_usage_1] or [A/contract.txt]. Use only ids that appear in the snapshot.
- When asked what to do, give the owner and the date, and the "how" steps if useful. When asked to draft a message, write it ready to send.
- Money: keep each account in its own currency (GBP for account A, EUR for account B). Never add them together.`;

function snapshot(state, collab) {
  const s = state;
  return JSON.stringify({
    as_of: s.asOf,
    accounts: s.accounts.map((a) => ({
      id: a.id, name: a.name, currency: a.currency, annual: a.annual, renewal_date: a.term_ends, days_to_renewal: a.days_to_renewal,
      summary: a.summary, health: { score: a.healthScore.score, label: a.healthScore.label, parts: a.healthScore.parts.map((p) => ({ name: p.name, score: p.score, why: p.why, cites: p.cites })) },
      forecast: a.forecast,
      five_answers: a.answers.map((x) => ({ q: x.q, answer: x.short, detail: x.more, cites: x.cites })),
      deals: a.pipeline.map((d) => ({ id: d.id, title: d.title, stage: d.stageLabel, value: d.valueText, forecast: d.forecast, decider: d.decider, blocker: d.blocker, qualification: d.meddpicc?.map((m) => `${m.name}: ${m.s} — ${m.note}`), cites: d.cites })),
      people: a.people.map((p) => ({ name: p.name, role: p.role, stance: p.relationship, met: p.met, last_contact: p.last_contact, cites: p.cites })),
      actions: a.moves.map((m) => ({ rank: m.rank, what: m.short, why: m.why, owner: m.owner.name, role: m.role, due: m.due, deal: m.deal, how: m.how?.steps, status: collab.tasks[m.id]?.status || "todo", cites: m.cites })),
      risks: a.risks.map((r) => ({ level: r.level, title: r.title, detail: r.detail, turns_bad: r.turns_bad, cites: r.cites })),
      unknowns: a.gaps.map((g) => ({ what: g.what, why: g.why, ask: g.who, cites: g.cites })),
      open_tickets: a.tickets.filter((t) => t.open).map((t) => ({ id: t.id, subject: t.subject, from: t.from, waiting: t.waiting, owner: t.owner || "none", priority: t.priority, cites: t.cites })),
      recent_activity: a.activities.slice(0, 12).map((x) => ({ date: x.date, type: x.type, title: x.title, summary: x.summary, cites: x.cites })),
    })),
    recent_changes: s.changes.slice(0, 10).map((c) => ({ at: c.at, what: c.summary })),
  });
}

export async function ask({ question, history = [], state: st, collab }) {
  const state = typeof st === "function" ? st() : st;
  if (!hasKey()) return ruleBased(question, state);
  try {
    const transcript = history.slice(-8).map((m) => `${m.ai ? "Flightdeck" : `${m.author}${m.role ? ` (${m.role})` : ""}`}: ${m.text}`).join("\n");
    const res = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [
        { type: "text", text: SYSTEM },
        { type: "text", text: `CRM snapshot (JSON):\n${snapshot(state, collab)}`, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: `${transcript ? `Recent team chat:\n${transcript}\n\n` : ""}Question: ${question}` }],
    });
    if (res.stop_reason === "refusal") return { text: "I can't help with that one. Try asking about a deal, a risk, or what to do next.", source: "claude" };
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return { text: text || ruleBased(question, state).text, source: "claude" };
  } catch (e) {
    if (Anthropic && e instanceof Anthropic.APIError) console.error("[assistant]", e.status, e.message);
    else console.error("[assistant]", e.message);
    const fb = ruleBased(question, state);
    return { ...fb, text: fb.text + "\n\n(The AI coach is unavailable right now, so this is the built-in answer.)" };
  }
}

// Built-in coach: understands the common questions without an API key.
export function ruleBased(question, state) {
  const q = question.toLowerCase();
  // pick accounts named in the question (by name, short name or a person on the account)
  const named = state.accounts.filter((a) => [a.name, a.short, ...a.people.map((p) => p.name.split(" ").pop())].some((w) => w && q.includes(String(w).toLowerCase())));
  const accs = named.length ? named : state.accounts;
  const c = (ids) => (ids || []).slice(0, 2).map((i) => `[${i}]`).join(" ");
  const d = (x) => (x ? new Date(x + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "");
  const out = [];
  let unknownIntent = false;
  for (const a of accs) {
    const head = accs.length > 1 ? `**${a.name}**\n` : "";
    if (/first|next|do|today|todo|to-do|priority|plan|monday|action/.test(q)) out.push(head + a.moves.slice(0, 3).map((m) => `${m.rank}. **${m.short}**\n    ${m.owner.name}${/\(/.test(m.owner.name) ? "" : ` (${m.role})`} · by ${d(m.due)} ${c(m.cites)}`).join("\n"));
    else if (/risk|wrong|worr|red|danger|late|deadline/.test(q)) out.push(head + a.risks.filter((r) => r.level === "red").slice(0, 4).map((r) => `• **${r.title}**${r.turns_bad ? ` — turns bad ${d(r.turns_bad)}` : ""} ${c(r.cites)}`).join("\n"));
    else if (/who|power|decide|sign|pay|buyer|champion|contact|people/.test(q)) out.push(head + a.answers[1].short + ". " + a.answers[1].more + " " + c(a.answers[1].cites));
    else if (/worth|value|book|revenue|money|forecast|commit|pipeline/.test(q)) out.push(head + `We can back **${a.answers[0].short.split(" · ")[0].replace(" we can back", "")}**: ${a.forecast.commitWhy}. At risk: ${a.answers[0].short.split(" · ")[1]?.replace(" at risk", "") || "—"} on docks nobody flies.${a.book.open_offers ? ` Open offers worth ${a.symbol}${Math.round(a.book.open_offers).toLocaleString("en-GB")} are pipeline, not counted.` : ""} ${c(a.forecast.cites)}`);
    else if (/know|gap|unknown|missing|blind/.test(q)) out.push(head + a.gaps.slice(0, 4).map((g) => `• ${g.what.replace(/\.$/, "")} → ask ${g.whoShort} ${c(g.cites)}`).join("\n"));
    else if (/ticket|support|request/.test(q)) out.push(head + (a.tickets.filter((t) => t.open).map((t) => `• ${t.id} ${t.subject} — waiting ${t.waiting}, ${t.owner || "no owner"} ${c(t.cites)}`).join("\n") || "No open tickets."));
    else if (/health|score|how is|status/.test(q)) out.push(head + `Health ${a.healthScore.score}/100 (${a.healthScore.label}). ` + a.healthScore.parts.map((p) => `${p.name} ${p.score}: ${p.why}`).join("; "));
    else if (/upsell|cross|expand|grow/.test(q)) out.push(head + a.growth.slice(0, 4).map((g) => `• ${g.title} — ${g.sizing}; next: ${g.next}`).join("\n"));
    else { out.push(head + a.summary + " " + c(a.answers[0].cites)); unknownIntent = true; }
  }
  if (unknownIntent) out.push("\nYou can ask me: what do we do first? · what could go wrong? · who decides? · what is it worth? · what don't we know? · open tickets · upsell ideas — or name an account.");
  return { text: out.join("\n\n"), source: "rules" };
}

export const assistantMode = () => (hasKey() ? "claude" : "rules");
