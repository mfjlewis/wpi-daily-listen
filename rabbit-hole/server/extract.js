// Fetch a URL and pull out the article text plus whatever citation metadata
// the page itself declares (meta tags, JSON-LD). Claude fills gaps later.

import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";

const UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

export class FetchError extends Error {
  constructor(message, { needsText = false } = {}) {
    super(message);
    this.needsText = needsText;
  }
}

function sniffCharset(contentType, bytes) {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType || "");
  if (fromHeader) return fromHeader[1];
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1] : "utf-8";
}

function decode(bytes, charset) {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export async function fetchPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en;q=0.8, *;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new FetchError(`Couldn't reach the site (${e.cause?.code || e.message}).`, { needsText: true });
  }
  if (!res.ok) {
    const blocked = [401, 402, 403, 429, 451].includes(res.status);
    throw new FetchError(
      blocked
        ? `The site refused automated access (HTTP ${res.status}). Paste the article text instead.`
        : `The site returned HTTP ${res.status}.`,
      { needsText: true },
    );
  }
  const type = res.headers.get("content-type") || "";
  if (!/html|xml|text\/plain/i.test(type)) {
    throw new FetchError(`That link is ${type.split(";")[0] || "not a web page"}; only web pages are supported so far.`, { needsText: true });
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const html = decode(bytes, sniffCharset(type, bytes));
  return { html, finalUrl: res.url || url };
}

function metaContent(doc, selectors) {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return "";
}

function jsonLdArticle(doc) {
  const out = {};
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(s.textContent);
    } catch {
      continue;
    }
    const nodes = [].concat(data?.["@graph"] || data || []);
    for (const n of nodes) {
      const type = [].concat(n?.["@type"] || []).join(" ");
      if (!/Article|BlogPosting|Report|WebPage/i.test(type)) continue;
      out.title ||= n.headline || n.name;
      out.published ||= n.datePublished || n.dateCreated;
      const authors = [].concat(n.author || []).map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean);
      if (authors.length && !out.authors) out.authors = authors;
      out.outlet ||= typeof n.publisher === "string" ? n.publisher : n.publisher?.name;
      out.language ||= n.inLanguage;
    }
  }
  return out;
}

const BLOCKS = "p, h1, h2, h3, h4, h5, li, blockquote, pre, figcaption, td";

function paragraphsFromHtml(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  const doc = dom.window.document;
  const out = [];
  for (const el of doc.querySelectorAll(BLOCKS)) {
    // skip containers whose text is already captured by a nested block
    if (el.querySelector(BLOCKS)) continue;
    const t = el.textContent.replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  }
  return out;
}

export function paragraphsFromText(text) {
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // single-newline text (common when pasting): fall back to line splits
  if (blocks.length <= 2 && text.split("\n").filter((l) => l.trim()).length > 4) {
    return text.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  return blocks;
}

export function extractArticle(html, url) {
  const virtualConsole = new VirtualConsole(); // swallow CSS/JS parse noise
  const dom = new JSDOM(html, { url, virtualConsole });
  const doc = dom.window.document;

  const ld = jsonLdArticle(doc);
  const meta = {
    title: metaContent(doc, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) || ld.title || doc.title?.trim() || "",
    authors:
      ld.authors ||
      [metaContent(doc, ['meta[name="author"]', 'meta[property="article:author"]', 'meta[name="byl"]'])].filter(
        (a) => a && !/^https?:/.test(a),
      ),
    outlet: metaContent(doc, ['meta[property="og:site_name"]', 'meta[name="application-name"]']) || ld.outlet || "",
    publishedAt:
      metaContent(doc, [
        'meta[property="article:published_time"]',
        'meta[name="pubdate"]',
        'meta[name="date"]',
        'meta[itemprop="datePublished"]',
        'meta[name="DC.date.issued"]',
      ]) ||
      doc.querySelector("time[datetime]")?.getAttribute("datetime") ||
      ld.published ||
      "",
    language: doc.documentElement.getAttribute("lang") || ld.language || "",
  };

  const article = new Readability(doc).parse();
  let paragraphs = article?.content ? paragraphsFromHtml(article.content) : [];
  if (paragraphs.length === 0 && article?.textContent) paragraphs = paragraphsFromText(article.textContent);
  if (article?.byline && meta.authors.length === 0) meta.authors = [article.byline.replace(/^(by|von|par|автор:?)\s+/i, "")];
  if (article?.title && !meta.title) meta.title = article.title;
  if (article?.siteName && !meta.outlet) meta.outlet = article.siteName;

  // drop leading paragraphs that just repeat the title or the byline
  const debris = new Set([meta.title, article?.title, ...meta.authors].filter(Boolean).map((s) => s.trim().toLowerCase()));
  while (paragraphs.length && paragraphs[0].length < 200 && debris.has(paragraphs[0].trim().toLowerCase().replace(/^(by|von|par)\s+/, ""))) paragraphs.shift();

  return { meta, paragraphs };
}
