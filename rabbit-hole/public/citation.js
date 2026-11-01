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

/**
 * @param {object} c citation object from an item
 * @param {{plain?: boolean}} opts plain=true returns text; otherwise HTML with <i> for the outlet
 */
export function chicagoCitation(c, opts = {}) {
  const esc = opts.plain ? (s) => s : (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const parts = [];
  const authors = authorList(c.authors);
  if (authors) parts.push(esc(endWithPeriod(authors)));

  const title = c.title || c.titleEn || c.url;
  let t = `“${esc(title.replace(/[.\s]+$/, ""))}.”`;
  if (c.titleEn && c.title && c.titleEn.trim() !== c.title.trim()) {
    t = `“${esc(c.title.replace(/[.\s]+$/, ""))}” [${esc(c.titleEn.replace(/[.\s]+$/, ""))}].`;
  }
  parts.push(t);

  const pub = [];
  if (c.outlet) pub.push(opts.plain ? c.outlet : `<i>${esc(c.outlet)}</i>`);
  if (c.publishedAt) pub.push(formatDate(c.publishedAt));
  if (pub.length) parts.push(`${pub.join(", ")}.`);
  if (!c.publishedAt && c.accessedAt) parts.push(`Accessed ${formatDate(c.accessedAt)}.`);
  if (c.url) parts.push(`${esc(c.url)}.`);
  return parts.join(" ");
}
