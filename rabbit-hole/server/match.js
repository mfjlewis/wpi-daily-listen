// Find which saved article (and which paragraphs) a screenshot came from.
// Works on word bigrams so OCR slips and line breaks don't matter much.
// Matches against both the original text and the English, since a
// screenshot may have been taken of a browser-translated page.

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s) {
  const w = norm(s).split(" ").filter(Boolean);
  const set = new Set();
  for (let i = 0; i < w.length - 1; i++) set.add(`${w[i]} ${w[i + 1]}`);
  if (w.length === 1) set.add(w[0]);
  return set;
}

function overlap(needle, hay) {
  if (needle.size === 0) return 0;
  let hit = 0;
  for (const g of needle) if (hay.has(g)) hit++;
  return hit / needle.size;
}

/**
 * @param {{text: string, english?: string}} shot  OCR result
 * @param {Array} items  saved items with paragraphs [{orig, en}]
 * @returns {{itemId, paragraphs: number[], score} | null}
 */
export function matchScreenshot(shot, items) {
  const pieces = (shot.text || "")
    .split(/\n\s*\n|\n/)
    .map((s) => s.trim())
    .filter((s) => norm(s).split(" ").length >= 4);
  const enPieces = (shot.english || "")
    .split(/\n\s*\n|\n/)
    .map((s) => s.trim())
    .filter((s) => norm(s).split(" ").length >= 4);
  if (pieces.length === 0 && enPieces.length === 0) return null;

  let best = null;
  for (const item of items) {
    const paras = (item.paragraphs || []).map((p) => ({ orig: bigrams(p.orig), en: bigrams(p.en) }));
    if (paras.length === 0) continue;
    const hits = new Map(); // paragraph index -> best score
    let total = 0;
    const consider = (list, field) => {
      for (const piece of list) {
        const g = bigrams(piece);
        let bi = -1;
        let bs = 0;
        paras.forEach((p, i) => {
          const s = overlap(g, p[field]);
          if (s > bs) {
            bs = s;
            bi = i;
          }
        });
        if (bs >= 0.35) {
          hits.set(bi, Math.max(hits.get(bi) || 0, bs));
          total += bs;
        }
      }
    };
    consider(pieces, "orig");
    consider(pieces, "en");
    consider(enPieces, "en");
    const denom = Math.max(1, pieces.length + enPieces.length);
    const score = total / denom;
    if (hits.size && (!best || score > best.score)) {
      best = { itemId: item.id, paragraphs: [...hits.keys()].sort((a, b) => a - b), score };
    }
  }
  return best && best.score >= 0.2 ? best : null;
}

/**
 * Locate text the user selected on the page (from the browser extension)
 * in a saved item. Returns { paragraphs, side } where side says whether the
 * selection matched the original ("orig") or the English ("en", e.g. when
 * the user was reading a browser-translated page). null if not found.
 */
export function matchSelection(text, item) {
  const pieces = String(text || "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => norm(s).length >= 3);
  if (!pieces.length) return null;
  const paras = item.paragraphs || [];
  const hits = new Set();
  const sides = { orig: 0, en: 0 };
  for (const piece of pieces) {
    const n = norm(piece);
    let found = false;
    for (const side of ["orig", "en"]) {
      const i = paras.findIndex((p) => norm(p[side]).includes(n));
      if (i >= 0) {
        hits.add(i);
        sides[side]++;
        found = true;
        break;
      }
    }
    if (!found && n.split(" ").length >= 4) {
      // fuzzy fallback for selections that cross formatting the extractor flattened
      const g = bigrams(piece);
      let best = -1;
      let bs = 0;
      let bside = "orig";
      paras.forEach((p, i) => {
        for (const side of ["orig", "en"]) {
          const s = overlap(g, bigrams(p[side]));
          if (s > bs) [bs, best, bside] = [s, i, side];
        }
      });
      if (bs >= 0.5) {
        hits.add(best);
        sides[bside]++;
      }
    }
  }
  if (!hits.size) return null;
  return { paragraphs: [...hits].sort((a, b) => a - b), side: sides.en > sides.orig ? "en" : "orig" };
}
