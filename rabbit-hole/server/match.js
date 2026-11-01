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
