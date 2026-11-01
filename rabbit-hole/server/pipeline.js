// Background processing for saved items:
//   fetch → extract → analyze (citation + tags) → translate/prepare → file into thread
// Items are processed one at a time; saving a link returns immediately.

import * as store from "./store.js";
import { fetchPage, extractArticle, paragraphsFromText, FetchError } from "./extract.js";
import { analyzeArticle, translateAndPrepare, assignThread, catalogFile } from "./claude.js";
import { PDFDocument } from "pdf-lib";
import { archiveUrl } from "./wayback.js";
import { matchSelection } from "./match.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const queue = [];
let running = false;

export function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  if (!running) run();
}

export function resumePending() {
  for (const item of store.listItems().slice().reverse()) {
    if (!["done", "error", "needs_text"].includes(item.status)) enqueue(item.id);
    else if (item.status === "done" && item.url && item.citation.archiveStatus === "pending") archive(item.id);
  }
}

async function run() {
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try {
      await processItem(id);
    } catch (e) {
      console.error(`[${id}]`, e);
      store.updateItem(id, {
        status: e instanceof FetchError && e.needsText ? "needs_text" : "error",
        error: e.message,
        statusDetail: "",
      });
    }
  }
  running = false;
}

function setStatus(id, status, statusDetail = "") {
  store.updateItem(id, { status, statusDetail, error: "" });
}

function tagVocabulary() {
  const counts = new Map();
  for (const it of store.listItems()) {
    for (const t of Object.values(it.tags || {}).flat()) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([t]) => t);
}

async function processItem(id) {
  let item = store.getItem(id);
  if (!item) return;
  if (item.kind === "file") return processFile(id);

  // 1. get the text
  let metaHints = { title: "", authors: [], outlet: "", publishedAt: "", language: "" };
  let paragraphs;
  if (item.pastedText?.trim()) {
    paragraphs = paragraphsFromText(item.pastedText);
  } else if (item.url) {
    let ex = null;
    const snap = path.join(store.itemDir(id), "snapshot.html");
    if (item.htmlProvided && fs.existsSync(snap)) {
      // page as the user saw it in their browser (sent by the extension)
      setStatus(id, "fetching", "Reading the page you saved");
      ex = extractArticle(fs.readFileSync(snap, "utf8"), item.url);
      if (ex.paragraphs.join(" ").length < 300) ex = null;
    }
    if (!ex) {
      setStatus(id, "fetching", "Downloading the page");
      const { html, finalUrl } = await fetchPage(item.url);
      store.writeItemFile(id, "snapshot.html", html);
      ex = extractArticle(html, finalUrl);
    }
    metaHints = ex.meta;
    paragraphs = ex.paragraphs;
    if (paragraphs.join(" ").length < 300) {
      throw new FetchError("Couldn't find the article text on that page (it may be paywalled or built with scripts). Paste the text instead.", { needsText: true });
    }
  } else {
    throw new FetchError("Nothing to process: add a URL or paste the text.", { needsText: true });
  }

  // 2. citation details + tags
  setStatus(id, "analyzing", "Reading for citation details and tags");
  const a = await analyzeArticle({ url: item.url, metaHints, paragraphs, vocabulary: tagVocabulary() });
  item = store.updateItem(id, (it) => ({
    citation: {
      ...it.citation,
      title: a.title || metaHints.title || it.citation.title,
      titleEn: a.titleEn || a.title || "",
      authors: a.authors?.length ? a.authors : metaHints.authors || [],
      outlet: a.outlet || metaHints.outlet || "",
      publishedAt: a.publishedAt || "",
      language: a.language || "",
      languageName: a.languageName || "",
    },
    summary: a.summary || "",
    tags: a.tags || it.tags,
    paragraphs: paragraphs.map((orig) => ({ orig, en: "", listen: "" })),
  }));

  // 3. translation + listening version
  const english = /^en\b/i.test(item.citation.language);
  setStatus(id, "translating", english ? "Preparing for listening" : `Translating from ${item.citation.languageName || "the original"}`);
  const prepared = await translateAndPrepare({
    paragraphs,
    language: item.citation.language,
    languageName: item.citation.languageName,
    onProgress: (done, total) =>
      total > 1 && store.updateItem(id, { statusDetail: `${english ? "Preparing" : "Translating"}: part ${done} of ${total}` }),
  });
  item = store.updateItem(id, { paragraphs: prepared });

  // 4. file into a research thread (unless the user already chose one)
  if (!item.threadId) {
    setStatus(id, "filing", "Filing into a research thread");
    await fileIntoThread(id);
  }

  store.updateItem(id, { status: "done", statusDetail: "", error: "", pastedText: "" });
  applyPendingHighlights(id);
  if (item.url) archive(id);
}

export async function fileIntoThread(id) {
  const item = store.getItem(id);
  const threads = store.listThreads().slice(0, 60).map((t) => {
    const members = store.threadItems(t.id);
    const tags = [...new Set(members.flatMap((m) => Object.values(m.tags || {}).flat()))].slice(0, 25);
    return { id: t.id, title: t.title, summary: t.summary, tags, sources: members.length };
  });
  const r = await assignThread({ item, threads });
  let thread = r.action === "join" ? store.getThread(r.threadId) : null;
  if (thread) {
    if (!thread.titleLocked && r.title) thread.title = r.title;
    if (r.summary) thread.summary = r.summary;
    store.saveThread(thread);
  } else {
    thread = store.createThread({ title: r.title || item.citation.titleEn || "Untitled thread", summary: r.summary || "" });
  }
  store.updateItem(id, { threadId: thread.id });
}

async function archive(id) {
  const item = store.getItem(id);
  if (!item?.url) return;
  store.updateItem(id, (it) => ({ citation: { ...it.citation, archiveStatus: "working" } }));
  const r = await archiveUrl(item.url);
  store.updateItem(id, (it) => ({
    citation: { ...it.citation, archiveStatus: r.status, archiveUrl: r.url || it.citation.archiveUrl },
  }));
}

export { archive as archiveItem };

// ---------------------------------------------------------------- selections from the extension

export function addPendingHighlight(id, { text, note = "" }) {
  const it = store.getItem(id);
  const same = (s) => (s || "").trim() === text.trim();
  // saving the same page twice with the same text still selected shouldn't double up
  if (it.highlights.some((h) => same(h.quoteOrig) || same(h.quoteEn)) || (it.pendingHighlights || []).some((h) => same(h.text))) return;
  store.updateItem(id, (it) => ({ pendingHighlights: [...(it.pendingHighlights || []), { text, note }] }));
  if (store.getItem(id).status === "done") applyPendingHighlights(id);
}

function applyPendingHighlights(id) {
  const item = store.getItem(id);
  const pending = item?.pendingHighlights || [];
  if (!pending.length || !item.paragraphs.length) return;
  for (const { text, note } of pending) {
    const m = matchSelection(text, item);
    const paras = m?.paragraphs || [];
    const joined = (side) => paras.map((i) => item.paragraphs[i][side]).join("\n\n");
    item.highlights.push({
      id: crypto.randomBytes(4).toString("hex"),
      paragraph: paras[0] ?? 0,
      paragraphs: paras,
      // keep exactly what was selected on the side it was selected from;
      // the other side is the whole matching paragraph(s)
      quoteOrig: m?.side === "en" ? joined("orig") : text,
      quoteEn: m?.side === "en" ? text : paras.length ? joined("en") : "",
      note: note || (m ? "" : "Selected text (couldn't locate it in the saved text)"),
      screenshot: "",
      createdAt: new Date().toISOString(),
    });
  }
  item.highlights.sort((a, b) => a.paragraph - b.paragraph);
  item.pendingHighlights = [];
  store.saveItem(item);
}

// ---------------------------------------------------------------- uploaded files
// Files are reference material: we read only the first few pages to get
// citation details, a short description and tags. No translation or audio.

const PREVIEW_PAGES = 8;
const CLAUDE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

async function firstPages(bytes) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const total = src.getPageCount();
  if (total <= PREVIEW_PAGES && bytes.length < 20_000_000) return { pdf: bytes, total };
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, [...Array(Math.min(PREVIEW_PAGES, total)).keys()]);
  pages.forEach((p) => out.addPage(p));
  return { pdf: Buffer.from(await out.save()), total };
}

async function processFile(id) {
  const item = store.getItem(id);
  const f = item.file;
  const bytes = fs.readFileSync(path.join(store.itemDir(id), "file", f.name));
  setStatus(id, "analyzing", "Reading the first pages for citation details");

  let input = null;
  let pages = f.pages || 0;
  let problem = "";
  try {
    if (f.mediaType === "application/pdf") {
      const { pdf, total } = await firstPages(bytes);
      pages = total;
      input = { base64: Buffer.from(pdf).toString("base64"), mediaType: "application/pdf" };
    } else if (CLAUDE_IMAGE_TYPES.includes(f.mediaType) && bytes.length < 5_000_000) {
      input = { base64: bytes.toString("base64"), mediaType: f.mediaType };
    } else {
      problem = "Stored as-is. This kind of file isn't read automatically, so add the citation details yourself.";
    }
  } catch (e) {
    problem = `Couldn't open the file to read it (${e.message}). It's stored; add the citation details yourself.`;
  }

  if (input) {
    try {
      const a = await catalogFile({ ...input, fileName: f.name, pageCount: pages, vocabulary: tagVocabulary() });
      store.updateItem(id, (it) => ({
        citation: {
          ...it.citation,
          type: a.type || "other",
          title: a.title || it.citation.title,
          titleEn: a.titleEn || a.title || it.citation.titleEn,
          authors: a.authors || [],
          editors: a.editors || [],
          publisher: a.publisher || "",
          place: a.place || "",
          journal: a.journal || "",
          bookTitle: a.bookTitle || "",
          volume: a.volume || "",
          issue: a.issue || "",
          pages: a.pages || "",
          publishedAt: a.publishedAt || "",
          language: a.language || "",
          languageName: a.languageName || "",
        },
        summary: a.summary || "",
        tags: a.tags || it.tags,
      }));
    } catch (e) {
      problem = `Couldn't read the citation details automatically (${e.message}). Add them yourself.`;
    }
  }

  store.updateItem(id, (it) => ({ file: { ...it.file, pages }, error: problem }));
  if (!store.getItem(id).threadId) {
    setStatus(id, "filing", "Filing into a research thread");
    await fileIntoThread(id);
  }
  store.updateItem(id, { status: "done", statusDetail: "", error: problem });
}
