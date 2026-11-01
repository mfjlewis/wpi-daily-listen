import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import { enqueue, resumePending, fileIntoThread, archiveItem, addPendingHighlight } from "./pipeline.js";
import { DEMO, MODEL, readScreenshot, searchArchive } from "./claude.js";
import { matchScreenshot } from "./match.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "public");
const PORT = Number(process.env.PORT || 3000);
const APP_TOKEN = process.env.APP_TOKEN || "";
const COOKIE = "rh_session";
const sessionValue = APP_TOKEN ? crypto.createHash("sha256").update(`rabbit-hole:${APP_TOKEN}`).digest("hex") : "";

store.load();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "30mb" }));

// ---------------------------------------------------------------- auth

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => c.trim().split("=").map(decodeURIComponent)).filter((p) => p[0]),
  );
}
function sameSecret(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function authed(req) {
  if (!APP_TOKEN) return true;
  // browser extension sends the passphrase as a bearer token
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (bearer) return sameSecret(bearer[1], APP_TOKEN);
  return sameSecret(cookies(req)[COOKIE] || "", sessionValue);
}

app.post("/api/login", (req, res) => {
  const token = String(req.body?.token || "");
  if (!APP_TOKEN || token !== APP_TOKEN) return res.status(401).json({ error: "Wrong passphrase." });
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${sessionValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}${req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`,
  );
  res.json({ ok: true });
});

app.get("/api/status", (req, res) => {
  res.json({ authed: authed(req), demo: DEMO, model: DEMO ? null : MODEL, needsLogin: !!APP_TOKEN });
});

app.use(["/api", "/share", "/files"], (req, res, next) => {
  if (authed(req)) return next();
  if (req.baseUrl === "/share") return res.redirect(`/#/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.status(401).json({ error: "Not signed in." });
});

// ---------------------------------------------------------------- helpers

function light(item) {
  const { paragraphs, highlights, pastedText, ...rest } = item;
  return { ...rest, paragraphCount: paragraphs.length, highlightCount: highlights.length };
}

function threadSummary(t) {
  const members = store.threadItems(t.id);
  return {
    ...t,
    count: members.length,
    highlightCount: members.reduce((n, i) => n + i.highlights.length, 0),
    lastSaved: members.reduce((m, i) => (i.savedAt > m ? i.savedAt : m), ""),
    languages: [...new Set(members.map((i) => i.citation.languageName).filter(Boolean))],
    finished: members.filter((i) => i.progress.finished).length,
  };
}

function normalizeUrl(u) {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/.test(k)) x.searchParams.delete(k);
    return x.toString();
  } catch {
    return "";
  }
}

function findUrl(text) {
  return (String(text || "").match(/https?:\/\/[^\s<>"']+/) || [])[0] || "";
}

function getItemOr404(req, res) {
  const item = store.getItem(req.params.id);
  if (!item) res.status(404).json({ error: "Not found." });
  return item;
}

function addItem({ url, text, threadId, html, highlight }) {
  const clean = url ? normalizeUrl(url) : "";
  if (url && !clean) return { error: "That doesn't look like a web address." };
  if (clean && !text) {
    const existing = store.listItems().find((i) => i.url === clean);
    if (existing) {
      // the extension can rescue a page the server couldn't download
      if (html && ["needs_text", "error"].includes(existing.status)) {
        store.writeItemFile(existing.id, "snapshot.html", html);
        store.updateItem(existing.id, { htmlProvided: true, status: "queued", error: "" });
        enqueue(existing.id);
      }
      if (highlight) addPendingHighlight(existing.id, highlight);
      return { item: store.getItem(existing.id), duplicate: true };
    }
  }
  if (!clean && !text?.trim()) return { error: "Add a link or paste some text." };
  const item = store.createItem({ url: clean, text });
  if (html) {
    store.writeItemFile(item.id, "snapshot.html", html);
    store.updateItem(item.id, { htmlProvided: true });
  }
  if (threadId && store.getThread(threadId)) store.updateItem(item.id, { threadId });
  if (highlight) addPendingHighlight(item.id, highlight);
  enqueue(item.id);
  return { item: store.getItem(item.id) };
}

// ---------------------------------------------------------------- library

app.get("/api/library", (req, res) => {
  res.json({
    threads: store.listThreads().map(threadSummary).filter((t) => t.count > 0),
    items: store.listItems().map(light),
  });
});

app.post("/api/items", (req, res) => {
  let url = String(req.body?.url || "");
  let text = String(req.body?.text || "");
  if (!url) {
    // a pasted link, or pasted article text that includes its link
    const found = findUrl(text);
    if (found && text.trim().length - found.length < 50) [url, text] = [found, ""];
    else if (found) url = found;
  }
  const html = typeof req.body?.html === "string" && req.body.html.length > 200 ? req.body.html : "";
  const highlight = req.body?.highlight ? { text: String(req.body.highlight).slice(0, 5000), note: String(req.body?.note || "") } : null;
  const r = addItem({ url, text, threadId: req.body?.threadId, html, highlight });
  if (r.error) return res.status(400).json({ error: r.error });
  res.status(r.duplicate ? 200 : 201).json({ item: light(r.item), duplicate: !!r.duplicate });
});

// Android share sheet target (see manifest.webmanifest)
app.get("/share", (req, res) => {
  const url = req.query.url || findUrl(req.query.text) || findUrl(req.query.title);
  const r = addItem({ url: url ? String(url) : "", text: url ? "" : String(req.query.text || "") });
  if (r.error) return res.redirect(`/#/?error=${encodeURIComponent(r.error)}`);
  res.redirect(`/#/item/${r.item.id}${r.duplicate ? "?duplicate=1" : ""}`);
});

app.get("/api/items/:id", (req, res) => {
  const item = getItemOr404(req, res);
  if (!item) return;
  const { pastedText, ...rest } = item;
  const thread = item.threadId ? store.getThread(item.threadId) : null;
  res.json({ item: rest, thread, threads: store.listThreads().map((t) => ({ id: t.id, title: t.title })) });
});

app.patch("/api/items/:id", async (req, res) => {
  const item = getItemOr404(req, res);
  if (!item) return;
  const b = req.body || {};
  const oldThread = item.threadId;
  if (b.citation) {
    const allowed = ["title", "titleEn", "authors", "outlet", "publishedAt", "url", "archiveUrl"];
    for (const k of allowed) if (k in b.citation) item.citation[k] = b.citation[k];
  }
  if (b.tags) item.tags = { ...item.tags, ...b.tags };
  if ("threadId" in b) {
    if (b.threadId === "new") item.threadId = store.createThread({ title: b.newThreadTitle || item.citation.titleEn || "New thread" }).id;
    else if (b.threadId === "auto") item.threadId = null;
    else if (store.getThread(b.threadId)) item.threadId = b.threadId;
  }
  store.saveItem(item);
  if (b.threadId === "auto") {
    try {
      await fileIntoThread(item.id);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  if (oldThread && oldThread !== store.getItem(item.id).threadId && store.threadItems(oldThread).length === 0) store.deleteThread(oldThread);
  res.json({ item: store.getItem(item.id) });
});

app.post("/api/items/:id/text", (req, res) => {
  const item = getItemOr404(req, res);
  if (!item) return;
  const text = String(req.body?.text || "");
  if (text.trim().length < 50) return res.status(400).json({ error: "Paste the article text (at least a paragraph)." });
  store.updateItem(item.id, { pastedText: text, status: "queued", error: "" });
  enqueue(item.id);
  res.json({ ok: true });
});

app.post("/api/items/:id/reprocess", (req, res) => {
  const item = getItemOr404(req, res);
  if (!item) return;
  store.updateItem(item.id, { status: "queued", error: "" });
  enqueue(item.id);
  res.json({ ok: true });
});

app.post("/api/items/:id/archive", (req, res) => {
  const item = getItemOr404(req, res);
  if (!item) return;
  archiveItem(item.id);
  res.json({ ok: true });
});

app.delete("/api/items/:id", (req, res) => {
  if (!store.deleteItem(req.params.id)) return res.status(404).json({ error: "Not found." });
  res.json({ ok: true });
});

app.put("/api/items/:id/progress", (req, res) => {
  const item = getItemOr404(req, res);
  if (!item) return;
  const paragraph = Math.max(0, Math.min(Number(req.body?.paragraph) || 0, Math.max(0, item.paragraphs.length - 1)));
  const finished = !!req.body?.finished || item.progress.finished;
  store.updateItem(item.id, { progress: { paragraph, finished, updatedAt: new Date().toISOString() } });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- highlights

app.post("/api/items/:id/highlights", (req, res) => {
  const item = getItemOr404(req, res);
  if (!item) return;
  const i = Number(req.body?.paragraph);
  const p = item.paragraphs[i];
  if (!p) return res.status(400).json({ error: "No such paragraph." });
  const h = {
    id: crypto.randomBytes(4).toString("hex"),
    paragraph: i,
    quoteOrig: req.body?.quoteOrig || p.orig,
    quoteEn: req.body?.quoteEn || p.en,
    note: req.body?.note || "",
    screenshot: "",
    createdAt: new Date().toISOString(),
  };
  item.highlights.push(h);
  item.highlights.sort((a, b) => a.paragraph - b.paragraph);
  store.saveItem(item);
  res.status(201).json({ highlight: h });
});

app.patch("/api/items/:id/highlights/:hid", (req, res) => {
  const item = getItemOr404(req, res);
  if (!item) return;
  const h = item.highlights.find((x) => x.id === req.params.hid);
  if (!h) return res.status(404).json({ error: "Not found." });
  if ("note" in (req.body || {})) h.note = String(req.body.note);
  store.saveItem(item);
  res.json({ highlight: h });
});

app.delete("/api/items/:id/highlights/:hid", (req, res) => {
  const item = getItemOr404(req, res);
  if (!item) return;
  item.highlights = item.highlights.filter((x) => x.id !== req.params.hid);
  store.saveItem(item);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- screenshots

app.post("/api/screenshots", async (req, res) => {
  const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/s.exec(req.body?.image || "");
  if (!m) return res.status(400).json({ error: "Send a PNG, JPEG, WebP or GIF image." });
  const [, mediaType, ext, base64] = m;
  let ocr = req.body?.ocr;
  try {
    if (!ocr) ocr = await readScreenshot({ base64, mediaType });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  const candidates = req.body?.itemId ? [store.getItem(req.body.itemId)].filter(Boolean) : store.listItems().filter((i) => i.paragraphs.length);
  const match = matchScreenshot(ocr, candidates);
  const target = match ? store.getItem(match.itemId) : req.body?.itemId ? store.getItem(req.body.itemId) : null;
  if (!target) {
    return res.json({ matched: false, ocr, demo: !!ocr.demo, message: ocr.demo ? "Demo mode can't read screenshots. Add an API key to enable this." : "Couldn't match this screenshot to a saved article. Pick the article it came from." });
  }

  const name = `screenshots/${Date.now()}.${ext === "jpeg" ? "jpg" : ext}`;
  store.writeItemFile(target.id, name, Buffer.from(base64, "base64"));
  const paras = match?.itemId === target.id ? match.paragraphs : [];
  const created = [];
  if (paras.length) {
    const first = paras[0];
    const h = {
      id: crypto.randomBytes(4).toString("hex"),
      paragraph: first,
      paragraphs: paras,
      quoteOrig: ocr.text || paras.map((i) => target.paragraphs[i].orig).join("\n\n"),
      quoteEn: ocr.english || paras.map((i) => target.paragraphs[i].en).join("\n\n"),
      note: "",
      screenshot: name,
      createdAt: new Date().toISOString(),
    };
    target.highlights.push(h);
    created.push(h);
  } else {
    // couldn't place it in the text; keep it as an unanchored highlight on the item
    const h = {
      id: crypto.randomBytes(4).toString("hex"),
      paragraph: 0,
      paragraphs: [],
      quoteOrig: ocr.text || "",
      quoteEn: ocr.english || "",
      note: "Screenshot (couldn't locate the passage in the saved text)",
      screenshot: name,
      createdAt: new Date().toISOString(),
    };
    target.highlights.push(h);
    created.push(h);
  }
  target.highlights.sort((a, b) => a.paragraph - b.paragraph);
  store.saveItem(target);
  res.json({ matched: !!paras.length, itemId: target.id, highlights: created });
});

app.get("/files/:id/screenshots/:name", (req, res) => {
  if (!/^[\w.-]+$/.test(req.params.name)) return res.status(400).end();
  const f = path.join(store.itemDir(req.params.id), "screenshots", req.params.name);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

// ---------------------------------------------------------------- threads

app.get("/api/threads/:id", (req, res) => {
  const t = store.getThread(req.params.id);
  if (!t) return res.status(404).json({ error: "Not found." });
  const members = store.threadItems(t.id);
  res.json({
    thread: threadSummary(t),
    items: members.map(light),
    highlights: members.flatMap((i) => i.highlights.map((h) => ({ ...h, itemId: i.id, itemTitle: i.citation.titleEn || i.citation.title }))),
    citations: members.map((i) => ({ id: i.id, citation: i.citation })),
    threads: store.listThreads().filter((x) => x.id !== t.id).map((x) => ({ id: x.id, title: x.title })),
  });
});

app.patch("/api/threads/:id", (req, res) => {
  const t = store.getThread(req.params.id);
  if (!t) return res.status(404).json({ error: "Not found." });
  if (typeof req.body?.title === "string" && req.body.title.trim()) {
    t.title = req.body.title.trim();
    t.titleLocked = true;
  }
  if (typeof req.body?.summary === "string") t.summary = req.body.summary;
  if (typeof req.body?.notes === "string") t.notes = req.body.notes;
  store.saveThread(t);
  res.json({ thread: t });
});

app.post("/api/threads/:id/merge", (req, res) => {
  const from = store.getThread(req.params.id);
  const into = store.getThread(req.body?.into);
  if (!from || !into || from.id === into.id) return res.status(400).json({ error: "Pick a different thread to merge into." });
  for (const i of store.threadItems(from.id)) store.updateItem(i.id, { threadId: into.id });
  if (from.notes) into.notes = [into.notes, from.notes].filter(Boolean).join("\n\n");
  store.saveThread(into);
  store.deleteThread(from.id);
  res.json({ thread: into });
});

// ---------------------------------------------------------------- search

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ results: [] });
  const items = store.listItems().filter((i) => i.status === "done");
  const catalog = items.map((i) => ({
    id: i.id,
    title: i.citation.title,
    titleEn: i.citation.titleEn,
    outlet: i.citation.outlet,
    authors: i.citation.authors,
    date: i.citation.publishedAt,
    language: i.citation.languageName,
    saved: i.savedAt.slice(0, 10),
    thread: store.getThread(i.threadId)?.title || "",
    summary: i.summary,
    tags: Object.values(i.tags).flat(),
    highlights: i.highlights.map((h) => h.note).filter(Boolean),
  }));
  try {
    const r = catalog.length ? await searchArchive({ query: q, catalog }) : { results: [] };
    const byId = new Map(items.map((i) => [i.id, i]));
    res.json({
      results: (r.results || []).filter((x) => byId.has(x.id)).map((x) => ({ ...light(byId.get(x.id)), reason: x.reason, threadTitle: store.getThread(byId.get(x.id).threadId)?.title || "" })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/export", (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="rabbit-hole-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), threads: store.listThreads(), items: store.listItems() });
});

// ---------------------------------------------------------------- static

app.use(express.static(PUBLIC, { extensions: ["html"] }));

app.listen(PORT, () => {
  console.log(`Rabbit Hole on http://localhost:${PORT}  (data: ${store.DATA_DIR})`);
  if (DEMO) console.log("Demo mode: no ANTHROPIC_API_KEY, so translation, tagging and search are stand-ins.");
  if (!APP_TOKEN) console.log("No APP_TOKEN set: anyone who can reach this server can use it. Set one before deploying.");
  resumePending();
});
