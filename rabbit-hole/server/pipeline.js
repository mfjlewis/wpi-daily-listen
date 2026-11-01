// Background processing for saved items:
//   fetch → extract → analyze (citation + tags) → translate/prepare → file into thread
// Items are processed one at a time; saving a link returns immediately.

import * as store from "./store.js";
import { fetchPage, extractArticle, paragraphsFromText, FetchError } from "./extract.js";
import { analyzeArticle, translateAndPrepare, assignThread } from "./claude.js";
import { archiveUrl } from "./wayback.js";

const queue = [];
let running = false;

export function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  if (!running) run();
}

export function resumePending() {
  for (const item of store.listItems().slice().reverse()) {
    if (!["done", "error", "needs_text"].includes(item.status)) enqueue(item.id);
    else if (item.status === "done" && item.citation.archiveStatus === "pending") archive(item.id);
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

  // 1. get the text
  let metaHints = { title: "", authors: [], outlet: "", publishedAt: "", language: "" };
  let paragraphs;
  if (item.pastedText?.trim()) {
    paragraphs = paragraphsFromText(item.pastedText);
  } else if (item.url) {
    setStatus(id, "fetching", "Downloading the page");
    const { html, finalUrl } = await fetchPage(item.url);
    store.writeItemFile(id, "snapshot.html", html);
    const ex = extractArticle(html, finalUrl);
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
