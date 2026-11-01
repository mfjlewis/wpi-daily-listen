// Chicago-style (notes-bibliography) bibliography entry for a web article.
// Shared by the browser and the server (for the readable item.md export).
//
//   Lastname, First. "Original Title" [English Title]. Outlet, Month D, YYYY. URL.
//
// Foreign-language titles keep the original and add a bracketed English
// translation, per Chicago 14.98 / 11.6.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

export function formatDate(iso) {
  if (!iso) return "";
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  if (!mo) return y;
  const month = MONTHS[Number(mo) - 1] || "";
  return d ? `${month} ${Number(d)}, ${y}` : `${month} ${y}`;
}

function invertName(name) {
  const n = name.trim();
  if (!n || n.includes(",")) return n;
  const parts = n.split(/\s+/);
  if (parts.length < 2) return n;
  const last = parts.pop();
  return `${last}, ${parts.join(" ")}`;
}

function authorList(authors = []) {
  const a = authors.filter(Boolean);
  if (a.length === 0) return "";
  if (a.length === 1) return invertName(a[0]);
  if (a.length === 2) return `${invertName(a[0])}, and ${a[1]}`;
  return `${invertName(a[0])}, ${a.slice(1, -1).join(", ")}, and ${a[a.length - 1]}`;
}

function endWithPeriod(s) {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function titleWithTranslation(c, esc, { italic = false, plain = false } = {}) {
  const clean = (t) => esc(String(t).replace(/[.\s]+$/, ""));
  const wrap = (t) => (italic && !plain ? `<i>${t}</i>` : t);
  // Chicago: non-Latin-script titles are cited in romanized form
  const title = c.titleTranslit || c.title || c.titleEn || c.fileName || c.url || "Untitled";
  const translated = c.titleEn && c.title && c.titleEn.trim() !== c.title.trim() ? ` [${clean(c.titleEn)}]` : "";
  return { title: wrap(clean(title)), translated };
}

/**
 * Chicago bibliography entry. Handles web articles (default), books,
 * journal articles, chapters in edited books, and reports.
 * @param {object} c citation object from an item
 * @param {{plain?: boolean}} opts plain=true returns text; otherwise HTML with <i> for italics
 */
export function chicagoCitation(c, opts = {}) {
  const esc = opts.plain ? (s) => s : (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const it = (s) => (opts.plain ? s : `<i>${esc(s)}</i>`);
  const parts = [];
  const authors = authorList(c.authors);
  const type = c.type || "web";
  const year = (c.publishedAt || "").slice(0, 4);

  if (type === "book" || type === "report") {
    if (authors) parts.push(esc(endWithPeriod(authors)));
    else if (c.editors?.length) parts.push(esc(endWithPeriod(`${authorList(c.editors)}, ${c.editors.length > 1 ? "eds" : "ed"}`)));
    const t = titleWithTranslation(c, esc, { italic: true, plain: opts.plain });
    parts.push(`${t.title}${t.translated}.`);
    if (authors && c.editors?.length) parts.push(esc(`Edited by ${c.editors.join(" and ")}.`));
    const pub = [c.place && `${c.place}:`, c.publisher].filter(Boolean).join(" ");
    const tail = [pub, year].filter(Boolean).join(", ");
    if (tail) parts.push(`${esc(tail)}.`);
    if (c.url) parts.push(`${esc(c.url)}.`);
    return parts.join(" ");
  }

  if (type === "journal") {
    if (authors) parts.push(esc(endWithPeriod(authors)));
    const t = titleWithTranslation(c, esc);
    parts.push(t.translated ? `“${t.title}”${t.translated}.` : `“${t.title}.”`);
    let j = c.journal ? it(c.journal) : "";
    if (c.volume) j += ` ${esc(c.volume)}`;
    if (c.issue) j += `, no. ${esc(c.issue)}`;
    if (year) j += ` (${esc(year)})`;
    if (c.pages) j += `: ${esc(c.pages)}`;
    if (j.trim()) parts.push(`${j.trim()}.`);
    if (c.url) parts.push(`${esc(c.url)}.`);
    return parts.join(" ");
  }

  if (type === "chapter") {
    if (authors) parts.push(esc(endWithPeriod(authors)));
    const t = titleWithTranslation(c, esc);
    parts.push(t.translated ? `“${t.title}”${t.translated}.` : `“${t.title}.”`);
    let inBook = c.bookTitle ? `In ${it(c.bookTitle)}` : "";
    if (c.editors?.length) inBook += `${inBook ? ", " : ""}edited by ${esc(c.editors.join(" and "))}`;
    if (c.pages) inBook += `, ${esc(c.pages)}`;
    if (inBook) parts.push(`${inBook}.`);
    const pub = [c.place && `${c.place}:`, c.publisher].filter(Boolean).join(" ");
    const tail = [pub, year].filter(Boolean).join(", ");
    if (tail) parts.push(`${esc(tail)}.`);
    if (c.url) parts.push(`${esc(c.url)}.`);
    return parts.join(" ");
  }

  if (type === "image") {
    const t = titleWithTranslation(c, esc);
    parts.push(`${t.title}${t.translated}.`);
    parts.push(year ? `Image, ${esc(year)}.` : "Image.");
    if (c.url) parts.push(`${esc(c.url)}.`);
    return parts.join(" ");
  }

  // web article
  if (authors) parts.push(esc(endWithPeriod(authors)));
  const t = titleWithTranslation(c, esc);
  parts.push(t.translated ? `“${t.title}”${t.translated}.` : `“${t.title}.”`);
  const pub = [];
  if (c.outlet) pub.push(it(c.outletTranslit || c.outlet));
  if (c.publishedAt) pub.push(formatDate(c.publishedAt));
  if (pub.length) parts.push(`${pub.join(", ")}.`);
  if (!c.publishedAt && c.accessedAt) parts.push(`Accessed ${formatDate(c.accessedAt)}.`);
  if (c.url) parts.push(`${esc(c.url)}.`);
  return parts.join(" ");
}

export const SOURCE_TYPES = {
  web: "Web article",
  book: "Book",
  journal: "Journal article",
  chapter: "Book chapter",
  report: "Report / document",
  image: "Image",
  other: "Other",
};
