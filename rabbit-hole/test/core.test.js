import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPage, extractArticle, paragraphsFromText } from "../server/extract.js";
import { chicagoCitation, formatDate } from "../public/citation.js";
import { matchScreenshot } from "../server/match.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const name = req.url.slice(1);
    if (name === "blocked") {
      res.writeHead(403);
      return res.end("no");
    }
    const f = path.join(here, "fixtures", name);
    if (!fs.existsSync(f)) {
      res.writeHead(404);
      return res.end();
    }
    // Russian fixture is served without a charset header, like many old sites
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test("decodes a windows-1251 page and extracts article + metadata", async () => {
  const { html, finalUrl } = await fetchPage(`${base}/ru-article.html`);
  const { meta, paragraphs } = extractArticle(html, finalUrl);
  assert.equal(meta.title, "Епископ Афанасий Шнайдер: «Проповедь не прекращается из-за законов»");
  assert.deepEqual(meta.authors, ["Мария Иванова"]);
  assert.equal(meta.outlet, "Католический вестник");
  assert.match(meta.publishedAt, /^2019-03-14/);
  assert.equal(meta.language, "ru");
  assert.equal(paragraphs.length, 5, `got ${paragraphs.length} paragraphs`);
  assert.match(paragraphs[0], /^Вспомогательный/, "byline should not be a paragraph");
  assert.ok(paragraphs.some((p) => p.includes("закон 2011 года")));
  assert.ok(!paragraphs.some((p) => p.includes("Подпишитесь")), "sidebar ad leaked into article");
});

test("reads JSON-LD metadata", async () => {
  const { html, finalUrl } = await fetchPage(`${base}/de-article.html`);
  const { meta, paragraphs } = extractArticle(html, finalUrl);
  assert.equal(meta.title, "Bischof Schneider: Mission in Kasachstan braucht Geduld");
  assert.deepEqual(meta.authors, ["Johannes Weber"]);
  assert.equal(meta.outlet, "Kirche in Not");
  assert.equal(meta.publishedAt, "2020-06-02");
  assert.equal(paragraphs.length, 4);
});

test("blocked sites ask for pasted text", async () => {
  await assert.rejects(fetchPage(`${base}/blocked`), (e) => e.needsText && /403/.test(e.message));
});

test("pasted text splits into paragraphs", () => {
  assert.equal(paragraphsFromText("One para.\n\nTwo para.\n\n\nThree.").length, 3);
  assert.equal(paragraphsFromText("a line\nb line\nc line\nd line\ne line").length, 5);
});

test("Chicago citation with translated title", () => {
  const c = {
    title: "Епископ Афанасий Шнайдер: «Проповедь не прекращается из-за законов»",
    titleEn: "Bishop Athanasius Schneider: “Preaching Does Not Stop Because of Laws”",
    authors: ["Maria Ivanova"],
    outlet: "Katolicheskii Vestnik",
    publishedAt: "2019-03-14",
    url: "https://example.org/a",
    accessedAt: "2026-11-01",
  };
  assert.equal(
    chicagoCitation(c, { plain: true }),
    "Ivanova, Maria. “Епископ Афанасий Шнайдер: «Проповедь не прекращается из-за законов»” [Bishop Athanasius Schneider: “Preaching Does Not Stop Because of Laws”]. Katolicheskii Vestnik, March 14, 2019. https://example.org/a.",
  );
  assert.match(chicagoCitation(c), /<i>Katolicheskii Vestnik<\/i>/);
});

test("Chicago citation without date or author uses access date", () => {
  const s = chicagoCitation({ title: "Hello", titleEn: "Hello", authors: [], outlet: "Site", publishedAt: "", url: "https://x.y", accessedAt: "2026-11-01" }, { plain: true });
  assert.equal(s, "“Hello.” Site. Accessed November 1, 2026. https://x.y.");
  assert.equal(formatDate("2019-03"), "March 2019");
});

test("screenshot text is matched to the right article and paragraph", () => {
  const items = [
    { id: "a", paragraphs: [{ orig: "Completely unrelated text about weather in Rome today.", en: "same" }] },
    {
      id: "b",
      paragraphs: [
        { orig: "Вспомогательный епископ Астаны Афанасий Шнайдер рассказал о том, как Церковь продолжает миссию.", en: "Auxiliary bishop of Astana Athanasius Schneider told how the Church continues its mission." },
        { orig: "По словам епископа, закон 2011 года требует регистрации всех миссионеров и запрещает распространение литературы.", en: "According to the bishop, the 2011 law requires registration of all missionaries and bans distributing literature." },
      ],
    },
  ];
  // OCR'd with a line break and a slip ("регистрацйи")
  const shot = { text: "По словам епископа, закон 2011 года требует\nрегистрацйи всех миссионеров и запрещает распространение литературы." };
  const m = matchScreenshot(shot, items);
  assert.equal(m.itemId, "b");
  assert.deepEqual(m.paragraphs, [1]);

  // screenshot of a browser-translated page matches via the English
  const m2 = matchScreenshot({ text: "According to the bishop, the 2011 law requires registration of all missionaries and bans distributing literature." }, items);
  assert.equal(m2.itemId, "b");

  assert.equal(matchScreenshot({ text: "Nothing like any saved article whatsoever here at all." }, items), null);
});
