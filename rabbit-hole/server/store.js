// File-based storage. Everything lives under DATA_DIR as plain, human-readable
// files so the archive outlives the app:
//
//   data/items/<id>/item.json        all metadata, paragraphs, highlights, progress
//   data/items/<id>/item.md          readable export: citation, summary, original + translation
//   data/items/<id>/snapshot.html    raw HTML as fetched at save time
//   data/items/<id>/screenshots/*    screenshots attached to the item
//   data/threads/<id>.json           research threads
//
// The in-memory maps are just a cache of what's on disk.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chicagoCitation } from "../public/citation.js";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const ITEMS_DIR = path.join(DATA_DIR, "items");
const THREADS_DIR = path.join(DATA_DIR, "threads");

const items = new Map();
const threads = new Map();

function ensureDirs() {
  fs.mkdirSync(ITEMS_DIR, { recursive: true });
  fs.mkdirSync(THREADS_DIR, { recursive: true });
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function newId(prefix = "") {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");
  return `${prefix}${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function load() {
  ensureDirs();
  items.clear();
  threads.clear();
  for (const id of fs.readdirSync(ITEMS_DIR)) {
    const f = path.join(ITEMS_DIR, id, "item.json");
    if (!fs.existsSync(f)) continue;
    try {
      items.set(id, JSON.parse(fs.readFileSync(f, "utf8")));
    } catch (e) {
      console.error(`Could not read ${f}: ${e.message}`);
    }
  }
  for (const name of fs.readdirSync(THREADS_DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(THREADS_DIR, name), "utf8"));
      threads.set(t.id, t);
    } catch (e) {
      console.error(`Could not read thread ${name}: ${e.message}`);
    }
  }
}

export function itemDir(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error("bad id");
  return path.join(ITEMS_DIR, id);
}

// ---- items ----

export function listItems() {
  return [...items.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function getItem(id) {
  return items.get(id) || null;
}

export function createItem(fields) {
  const now = new Date().toISOString();
  const item = {
    id: newId(),
    kind: fields.kind || "web", // "web" (saved link/text) or "file" (uploaded PDF, scan, image, document)
    file: fields.file || null, // { name, size, mediaType, pages, sha256 } for uploads
    url: fields.url || "",
    status: "queued", // queued | fetching | analyzing | translating | filing | done | needs_text | error
    statusDetail: "",
    error: "",
    savedAt: now,
    updatedAt: now,
    citation: {
      title: "",
      titleEn: "",
      authors: [],
      outlet: "",
      publishedAt: "",
      language: "",
      languageName: "",
      url: fields.url || "",
      accessedAt: now.slice(0, 10),
      archiveUrl: "",
      archiveStatus: "pending",
    },
    summary: "",
    tags: { people: [], places: [], organizations: [], topics: [] },
    threadId: null,
    paragraphs: [], // [{ orig, en, listen }]
    highlights: [],
    progress: { paragraph: 0, finished: false, updatedAt: null },
    pastedText: fields.text || "",
  };
  fs.mkdirSync(itemDir(item.id), { recursive: true });
  saveItem(item);
  return item;
}

export function saveItem(item) {
  item.updatedAt = new Date().toISOString();
  items.set(item.id, item);
  const dir = itemDir(item.id);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, "item.json"), JSON.stringify(item, null, 2));
  writeAtomic(path.join(dir, "item.md"), itemMarkdown(item));
  return item;
}

export function updateItem(id, patch) {
  const item = getItem(id);
  if (!item) return null;
  Object.assign(item, typeof patch === "function" ? patch(item) || {} : patch);
  return saveItem(item);
}

export function deleteItem(id) {
  const item = getItem(id);
  if (!item) return false;
  items.delete(id);
  fs.rmSync(itemDir(id), { recursive: true, force: true });
  if (item.threadId) {
    const remaining = listItems().filter((i) => i.threadId === item.threadId);
    if (remaining.length === 0) deleteThread(item.threadId);
  }
  return true;
}

export function writeItemFile(id, name, data) {
  const dir = itemDir(id);
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), data);
}

// ---- threads ----

export function listThreads() {
  return [...threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getThread(id) {
  return threads.get(id) || null;
}

export function createThread({ title, summary = "" }) {
  const now = new Date().toISOString();
  const t = { id: newId("t-"), title, summary, createdAt: now, updatedAt: now };
  return saveThread(t);
}

export function saveThread(t) {
  t.updatedAt = new Date().toISOString();
  threads.set(t.id, t);
  writeAtomic(path.join(THREADS_DIR, `${t.id}.json`), JSON.stringify(t, null, 2));
  return t;
}

export function deleteThread(id) {
  threads.delete(id);
  fs.rmSync(path.join(THREADS_DIR, `${id}.json`), { force: true });
}

export function threadItems(id) {
  return listItems()
    .filter((i) => i.threadId === id)
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt));
}

// ---- readable export ----

function itemMarkdown(item) {
  const c = item.citation;
  const lines = [];
  lines.push(`# ${c.titleEn || c.title || item.url || item.id}`);
  lines.push("");
  if (c.title && c.titleEn && c.title !== c.titleEn) lines.push(`Original title: ${c.title}`, "");
  lines.push(`- Citation (Chicago): ${chicagoCitation(c, { plain: true })}`);
  if (c.url) lines.push(`- URL: ${c.url}`);
  if (c.archiveUrl) lines.push(`- Archived copy: ${c.archiveUrl}`);
  if (item.file) lines.push(`- File: file/${item.file.name}${item.file.pages ? ` (${item.file.pages} pages)` : ""}`);
  if (c.authors?.length) lines.push(`- Author(s): ${c.authors.join("; ")}`);
  if (c.outlet) lines.push(`- Outlet: ${c.outlet}`);
  if (c.publishedAt) lines.push(`- Published: ${c.publishedAt}`);
  if (c.languageName) lines.push(`- Language: ${c.languageName}`);
  lines.push(`- Saved: ${item.savedAt}`);
  const thread = item.threadId && getThread(item.threadId);
  if (thread) lines.push(`- Research thread: ${thread.title}`);
  const tags = Object.values(item.tags || {}).flat();
  if (tags.length) lines.push(`- Tags: ${tags.join(", ")}`);
  lines.push("");
  if (item.summary) lines.push("## Summary", "", item.summary, "");
  if (item.highlights?.length) {
    lines.push("## Highlights", "");
    for (const h of item.highlights) {
      lines.push(`> ${h.quoteOrig || ""}`);
      if (h.quoteEn && h.quoteEn !== h.quoteOrig) lines.push(">", `> [EN, machine translation] ${h.quoteEn}`);
      const where = h.page ? `p. ${h.page}` : item.kind === "file" ? "" : `paragraph ${h.paragraph + 1}`;
      lines.push(`${where ? `(${where})` : ""}${h.note ? ` — ${h.note}` : ""}`, "");
    }
  }
  if (item.paragraphs?.length) {
    const translated = item.paragraphs.some((p) => p.en && p.en !== p.orig);
    lines.push("## Text", "");
    if (translated) lines.push("_English is a machine translation. Verify against the original before quoting._", "");
    item.paragraphs.forEach((p, i) => {
      lines.push(`**¶${i + 1}** ${p.orig}`);
      if (translated && p.en) lines.push("", `_EN:_ ${p.en}`);
      lines.push("");
    });
  }
  return lines.join("\n");
}
