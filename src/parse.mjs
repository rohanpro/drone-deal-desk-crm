// Parsing + cleaning helpers for the raw paperwork.

export function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x !== ""));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** "05/2026", "2026-08", "Jun 2026", "Aug-26", "10/2026" -> "2026-05" */
export function normMonth(s) {
  s = String(s).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) return `${m[1]}-${m[2].padStart(2, "0")}`;
  if ((m = s.match(/^(\d{1,2})\/(\d{4})$/))) return `${m[2]}-${m[1].padStart(2, "0")}`;
  if ((m = s.match(/^([A-Za-z]{3})[a-z]*[\s-](\d{2,4})$/))) {
    const y = m[2].length === 2 ? `20${m[2]}` : m[2];
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) return `${y}-${String(mo).padStart(2, "0")}`;
  }
  return null;
}

const FORCE_PATTERNS = [
  [/westm/i, "Westmere"],
  [/metro/i, "Metro Central"],
  [/tarn/i, "Tarn Valley"],
  [/norw/i, "Norwold"],
];
export const normForce = (s) => (FORCE_PATTERNS.find(([re]) => re.test(s)) || [null, s.trim()])[1];

/** Clean the force-by-month flight log; returns rows + a data-quality log explaining each fix. */
export function cleanForceLog(text) {
  const raw = parseCSV(text);
  const issues = [];
  const seen = new Map();
  const names = new Map();
  raw.forEach((r, i) => {
    const line = i + 2;
    const force = normForce(r.force);
    const month = normMonth(r.month);
    if (!names.has(force)) names.set(force, new Set());
    names.get(force).add(r.force);
    if (!month) { issues.push({ line, issue: `Unreadable month "${r.month}"; row skipped` }); return; }
    if (r.live_missions === "" && r.docks_with_live_flights !== "") {
      issues.push({ line, issue: `${force} ${month}: partial re-send ("${r.notes}"); ignored, the full row is kept` });
      return;
    }
    const key = `${force}|${month}`;
    if (seen.has(key)) { issues.push({ line, issue: `${force} ${month}: exact duplicate of line ${seen.get(key).line}; dropped` }); return; }
    seen.set(key, {
      line, force, month,
      docks_installed: +r.docks_installed, docks_with_live_flights: +r.docks_with_live_flights,
      live_missions: +r.live_missions, training_flights: +r.training_flights, notes: r.notes,
    });
  });
  for (const [f, set] of names) if (set.size > 1) issues.push({ line: null, issue: `"${f}" written ${set.size} ways: ${[...set].map((s) => `"${s}"`).join(", ")}; merged` });
  const rows = [...seen.values()].sort((a, b) => a.force.localeCompare(b.force) || a.month.localeCompare(b.month));
  const months = [...new Set(rows.map((r) => r.month))].sort();
  for (const f of new Set(rows.map((r) => r.force))) {
    for (const m of months) if (!rows.find((r) => r.force === f && r.month === m)) issues.push({ line: null, issue: `${f} has no row for ${m}; treated as unknown, not zero` });
  }
  const formats = new Set(raw.map((r) => r.month.replace(/\d/g, "9").replace(/[A-Za-z]+/g, "Mon")));
  if (formats.size > 1) issues.push({ line: null, issue: `Month written in ${formats.size} formats (${[...formats].join(", ")}); normalised to YYYY-MM` });
  return { rows, issues, months };
}

export const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
export const addDays = (d, n) => new Date(new Date(d).getTime() + n * 864e5).toISOString().slice(0, 10);
/** Friday of the week containing d */
export const fridayOf = (d) => { const x = new Date(d); const dow = x.getUTCDay(); return addDays(d, (5 - dow + 7) % 7); };
export const fmtDate = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
