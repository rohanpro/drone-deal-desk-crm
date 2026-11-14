# Flightdeck: the revenue cockpit for a drone-in-a-box SaaS team

**Live:** https://drone-deal-desk-crm.onrender.com · **MCP endpoint:** `POST https://drone-deal-desk-crm.onrender.com/mcp`

> Hosted on Render's free plan. The first visit after 15 idle minutes takes about 30 s while the app wakes and re-syncs.

Flightdeck is a live CRM for a B2B team that sells drone docks, aircraft and software to police forces and industrial groups. It reads everything through the **Account Quest MCP** and turns it into plain-English answers that the whole team can act on: customer success, account executives, solutions engineers, support, marketing and their manager.

**For each account it answers the five questions**, and every number links to the record it came from:
1. **What is the book worth?** Only the value that real usage backs. Claims are shown apart.
2. **Who holds the power?** Who decides, pays, uses and could block each deal, and how warm each person is.
3. **What do we do first?** Ranked actions with an owner, a date, the deal they move, and a playbook with steps, questions to ask and a ready-to-send draft.
4. **What is about to go wrong?** Red and amber risks, each with the date it turns bad.
5. **What do we still not know?** Each gap, why it matters, and who to ask.

**CRM features:** These were chosen after benchmarking 10 leading B2B CRMs (see [docs/crm-benchmark.md](docs/crm-benchmark.md)).
- A "Today" home showing each role's actions.
- A colour-coded pipeline board running Prospect → Discover → Qualify → Prove value → Proposal → Commit → Won/Lost.
- Forecast categories: Won, Commit, Best case and Pipeline.
- A MEDDPICC qualification checklist on every deal.
- An account health score that explains its own reasons.
- Customer lifecycle stages: Onboard → Adopt → Expand → Renew.
- A unified ticket queue with priorities and wait times.
- A history timeline of calls, emails, tickets, alerts, notes and invoices, each with the original attached.
- An upsell and cross-sell list.
- Team chat with a channel per account.
- **Ask Flightdeck**, a coach that answers from the account data. It uses Claude when `ANTHROPIC_API_KEY` is set and a built-in rule-based coach otherwise.
- Task status (to do, in progress, done) with team points.

## Run it

```bash
echo "AQ_TOKEN=<your token>" > .env      # never commit this; .gitignore covers it
npm install && npm start                 # http://localhost:8787
```

Node ≥ 20. The only dependency is `@anthropic-ai/sdk`, for the optional AI coach. Run `npm install` first. The app still runs without it. Optional env vars:

| var | meaning |
|---|---|
| `AQ_TOKEN` | Account Quest token (server-side only, never sent to the browser) |
| `PORT` | default 8787 |
| `WRITE_KEY` | if set, writing notes from the UI or `/mcp` needs this key |
| `AUTO_NOTES=0` | turn off automatic write-back of the #1 move and new red risks |
| `ANTHROPIC_API_KEY` | optional; turns on the Claude-powered coach in Team chat (model `claude-opus-5-5`, override with `ASSISTANT_MODEL`) |
| `SYNC=0` | serve stored data only (no MCP calls), e.g. for a second local copy |
| `DATA_DIR` | where the live store is kept (default `./data`) |

`seed/store.json` is a snapshot of the first pull, so a fresh deploy can render straight away. The sync then refreshes everything.

## How it stays live

The token allows **one call a minute**, so every call goes through a single queue that ticks every 62 s (`src/sync.mjs`):

- **Bootstrap:** fetch anything never fetched (accounts, both paperwork packs, files, team, schema…).
- **Rotation:** `signals → accounts → signals → paperwork A → whoami → signals → notes → signals → paperwork B → accounts`. Every source is refreshed at least every ~5 minutes. Live events are checked every ~2½ minutes.
- **whoami** acts as a cheap change detector. If its signal count changes, signals and accounts are refetched next.
- **Diffing:** each refresh is compared with the previous copy, so new signals, new or changed facts and stage moves land in a change log (the *Live feed* tab and the `whats_new` MCP tool).
- **Writes jump the queue:** `write_note` calls are queued and sent before any read.
- The browser gets a server push (SSE) on every change and re-renders. No reload is needed.

New data changes the answers **without a code change**, because every answer is computed from the store on each request.

## How it decides (the rules in `src/analyze.mjs`)

**Book**
- Price per dock = contract annual value ÷ docks on `devices.json`.
- Account A: *backed* = docks at forces with any live missions in the verified `flight_log_force_month` × price per dock. *At risk* = docks at forces with zero live missions.
- Account B (no force file): a dock is *regular* if it averaged 4+ flights a month over the last 3 months in `flights.csv`. Backed = regular docks × price. Light and idle docks count as at risk.
- Won offers count as backed. Open offers are pipeline and are not counted. Declined offers are excluded.
- Facts with status `claim`, and "told" dock counts nobody has put in writing, are **shown apart** with what they would imply. They are never added to the book.
- The two accounts use different currencies and are never summed.

**Power:** decider and payer come from the morning debrief. Users, blockers and champions come from facts, roles and paperwork, and each role carries its citation. People never met are marked as such.

**First moves:** each move has a score of `log10(10 + value at stake) × urgency × (1 + 7/(days_left+1))`. Moves come from rules:
- A live event asking for something "this week" or marked urgent → reply by the Friday of that week.
- A champion leaving → get the renewal agreed before he goes, and ask for his successor and introductions.
- Each debrief blocker → a specific unblocking move (DPIA documents, cost per flight, costed operating model, per-plant quote).
- Open requests with no owner → close out.
- Open offers → find the need before pitching.
- Never-met deciders → get an introduction.

**Risks:** these rules raise one, with a date it turns bad:
- Signal deadlines.
- A champion leaving.
- A renewal with no auto-renew (turns bad 30 days before term end).
- Forces with zero use.
- Falling usage.
- Battery warnings on busy docks while the customer's battery email has no reply.
- Docks repeatedly offline.
- Requests with no owner.
- People with no contact for 45 or 90 days.
- Deals resting on claims.

**Gaps:**
- What the profile says is *not on file*.
- Unread tickets.
- Claims.
- Deals the debrief says exist but discovery never heard of.
- Missing months in verified files.

Each gap names who could fill it.

## Sources and citations

Every citable thing goes into one evidence index: facts, people, deals, offers, files, paperwork records, tickets, signals, debrief items, FlytBase team members, and computed numbers (`calc:*`), which list their inputs. Click any chip in the UI to see where it came from and its raw text. An automated check (`npm run check`) fails loudly if any citation does not resolve.

The **morning debrief** is not served by the MCP, so it was transcribed once from the play page into `seed/morning.json`. It is labelled as such wherever it is used.

## Our own MCP server

`POST /mcp` speaks MCP (JSON-RPC over HTTP), so Claude or any MCP client can query the CRM:

| tool | does |
|---|---|
| `crm_overview` | both accounts: health, backed book, renewal, top move, red risks |
| `account_answers` | the five answers (plus growth) for one account, with source ids |
| `trace` | resolve any id to its source and raw text |
| `whats_new` | changes picked up by the sync |
| `queue_note` | write a note back to Account Quest via `write_note` |

## Layout

```
server.mjs            HTTP server: UI, /api/state, /api/events (SSE), /api/notes, /mcp
src/mcp-client.mjs    Account Quest MCP client (token from env)
src/sync.mjs          rate-limited sync queue, store, diff/change log, note write-back
src/analyze.mjs       the decision engine (five answers + growth), all cited
src/parse.mjs         CSV parsing, force-log cleaning, date helpers
src/mcp-server.mjs    our MCP endpoint
src/sales.mjs         sales-cycle layer: stages, MEDDPICC, forecast, health, tickets, timeline, playbooks
src/collab.mjs        team chat, task status, points (data/collab.json)
src/assistant.mjs     "Ask Flightdeck" coach (Claude, or the built-in rules)
docs/crm-benchmark.md what we took from the top 10 B2B CRMs
public/index.html     the UI (single file, no build) · public/brand.svg logo
seed/                 morning debrief + first-pull snapshot
scripts/              one-off pull, seed builder, citation check
```
