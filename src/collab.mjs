// Team collaboration state: chat channels, task progress, team points.
// Stored on the server (data/collab.json) so everyone sees the same thing.
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(process.env.DATA_DIR || path.resolve("data"), "collab.json");
fs.mkdirSync(path.dirname(FILE), { recursive: true });

export const collab = (() => {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { messages: [], tasks: {}, points: {} }; }
})();
const save = () => fs.writeFileSync(FILE, JSON.stringify(collab));
const listeners = new Set();
export const onCollab = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = (ev) => { for (const fn of listeners) try { fn(ev); } catch {} };

const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

export function addMessage({ channel, author, role, text, ai = false, ref = null }) {
  const m = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), channel: clean(channel || "general", 40), author: clean(author || "Someone", 40), role: clean(role || "", 40), text: clean(text, 4000), ai, ref: ref ? clean(ref, 120) : null, at: new Date().toISOString() };
  if (!m.text) return null;
  collab.messages.push(m);
  collab.messages = collab.messages.slice(-800);
  if (!ai) collab.points[m.author] = (collab.points[m.author] || 0) + 1;
  save(); emit({ type: "chat", message: m });
  return m;
}

export function setTask({ id, status, by, role }) {
  if (!["todo", "doing", "done"].includes(status)) return null;
  const prev = collab.tasks[id]?.status;
  collab.tasks[clean(id, 120)] = { status, by: clean(by, 40), role: clean(role, 40), at: new Date().toISOString() };
  if (status === "done" && prev !== "done") collab.points[clean(by, 40)] = (collab.points[clean(by, 40)] || 0) + 10;
  save(); emit({ type: "task", id, status });
  return collab.tasks[id];
}

export function publicCollab() {
  return { messages: collab.messages.slice(-300), tasks: collab.tasks, points: collab.points };
}
