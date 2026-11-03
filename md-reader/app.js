/* MD Reader — read, edit, highlight and export Markdown. All data stays on the device. */
(() => {
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ---------------- storage ---------------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

const DEFAULTS = { theme: 'auto', bg: '', font: 'serif', size: 19, lh: 1.6, width: 'medium', align: 'left', hl: 'yellow', wake: false, rate: 1, voice: '' };
const settings = Object.assign({}, DEFAULTS, store.get('mdr.settings', {}));
let docs = store.get('mdr.docs', []);
let curId = store.get('mdr.current', null);
let mode = 'read';

const WELCOME = `# Welcome to MD Reader

A small app for **reading**, **editing** and **exporting** Markdown files, built to sit on your phone's home screen.

## Reading
- Tap **Aa** to change the font, text size, line spacing, margins, alignment and theme (Auto, Light, Sepia, Gray, Dark, Black), or to pick your own background color.
- Tap the **magnifier** to find words. Use the arrows to jump between matches.
- Turn on **Keep screen on** under Aa for long reads.

## Highlighting
Select some text while reading and tap **Highlight**. ==Like this.== Tap a highlight to remove it. Pick the pen color under **Aa → Highlighter**.

Highlights are saved inside the Markdown itself (as \`==text==\`), so they stay with the file and carry through to Word, HTML and PDF exports.

## Editing
Tap **Edit** to change the Markdown. The toolbar adds bold, headings, lists, checklists, quotes, links and highlights. Changes save automatically.

## Files
- Tap **☰ → Open file…** to load a \`.md\` file from your phone.
- On Android, after the app is installed, you can also **share** a Markdown file to *MD Reader* from Files, Drive or email.
- Tap the **download arrow** to export as **Word**, **PDF**, **HTML** or **Markdown**.

> Everything stays on this device. Nothing is uploaded anywhere.

| Format | Best for |
|---|---|
| Word (.docx) | Editing further in Word or Google Docs |
| PDF | Sending or printing as-is |
| HTML | Opening in any browser |

- [x] Try a theme
- [ ] Highlight a sentence
- [ ] Export this page
`;

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function saveDocs() {
  if (!store.set('mdr.docs', docs)) toast('Storage is full — export and delete some documents.');
  store.set('mdr.current', curId);
}
function cur() { return docs.find(d => d.id === curId); }
function newDoc(title, content) {
  const d = { id: uid(), title: title || 'Untitled', content: content || '', updated: Date.now(), pos: 0 };
  docs.unshift(d); curId = d.id; saveDocs(); return d;
}
if (!docs.length) newDoc('Welcome', WELCOME);
if (!cur()) curId = docs[0].id;

/* ---------------- markdown ---------------- */
const HL_CLASSES = ['hl-green', 'hl-pink', 'hl-blue'];
marked.use({
  gfm: true, breaks: false,
  extensions: [{
    name: 'mark', level: 'inline',
    start(src) { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
    tokenizer(src) {
      const m = /^==(?=\S)([\s\S]*?\S)==(?!=)/.exec(src);
      if (m) return { type: 'mark', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
    },
    renderer(t) { return '<mark>' + this.parser.parseInline(t.tokens) + '</mark>'; },
  }],
});
/* YAML front matter (---\ntitle: …\n---) is shown as a small info box, not as a heading */
const FM_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
function splitFM(md) {
  md = md || '';
  const m = FM_RE.exec(md);
  if (!m) return { meta: null, body: md };
  const meta = [];
  m[1].split('\n').forEach(l => { const k = /^([\w .-]+):\s*(.*)$/.exec(l); if (k && k[2].trim()) meta.push([k[1].trim(), k[2].trim().replace(/^(["'])(.*)\1$/, '$2')]); });
  return { meta, body: md.slice(m[0].length) };
}
function fmHtml(meta) {
  if (!meta || !meta.length) return '';
  return '<details class="fm"><summary>Document info</summary>' + meta.map(([k, v]) => `<div><b>${escHtml(k)}</b><span>${escHtml(v)}</span></div>`).join('') + '</details>';
}
function mdToHtml(md) {
  return DOMPurify.sanitize(marked.parse(md || ''), { ADD_ATTR: ['target'] });
}

/* ---------------- settings / theme ---------------- */
const root = document.documentElement;
const FONT_VARS = { serif: 'var(--f-serif)', sans: 'var(--f-sans)', book: 'var(--f-book)', readable: 'var(--f-readable)', mono: 'var(--f-mono)' };
const WIDTHS = { narrow: '32rem', medium: '40rem', wide: '60rem' };

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
}
function applySettings() {
  root.dataset.theme = settings.theme;
  const s = root.style;
  s.setProperty('--font', FONT_VARS[settings.font] || FONT_VARS.serif);
  s.setProperty('--fs', settings.size + 'px');
  s.setProperty('--lh', settings.lh);
  s.setProperty('--measure', WIDTHS[settings.width] || WIDTHS.medium);
  s.setProperty('--align', settings.align);
  s.setProperty('--pen', `var(--hl-${settings.hl})`);
  if (settings.bg) {
    const dark = luminance(settings.bg) < 0.22;
    s.setProperty('--bg', settings.bg);
    s.setProperty('--fg', dark ? '#e6e6e6' : '#1d1d1f');
    s.setProperty('--muted', dark ? '#a0a0a0' : '#666');
    s.setProperty('--chrome', `color-mix(in srgb, ${settings.bg} 88%, ${dark ? '#fff' : '#000'})`);
    s.setProperty('--line', `color-mix(in srgb, ${settings.bg} 78%, ${dark ? '#fff' : '#000'})`);
    s.colorScheme = dark ? 'dark' : 'light';
  } else {
    ['--bg', '--fg', '--muted', '--chrome', '--line'].forEach(p => s.removeProperty(p));
    s.colorScheme = '';
  }
  const meta = $('meta[name="theme-color"]');
  meta.content = getComputedStyle(root).getPropertyValue('--chrome').trim() || '#1f2a44';

  $$('#themeSwatches button').forEach(b => b.classList.toggle('on', !settings.bg && b.dataset.theme === settings.theme));
  $$('#fontSeg button').forEach(b => b.classList.toggle('on', b.dataset.font === settings.font));
  $$('#widthSeg button').forEach(b => b.classList.toggle('on', b.dataset.width === settings.width));
  $$('#alignSeg button').forEach(b => b.classList.toggle('on', b.dataset.align === settings.align));
  $$('#hlColors button').forEach(b => b.classList.toggle('on', b.dataset.hl === settings.hl));
  $('#sizeRange').value = settings.size; $('#sizeVal').textContent = settings.size + 'px';
  $('#lhRange').value = settings.lh; $('#lhVal').textContent = (+settings.lh).toFixed(1);
  if (settings.bg) $('#customBg').value = settings.bg;
  $('#wakeLock').checked = settings.wake;
  store.set('mdr.settings', settings);
}
function setSetting(k, v) { settings[k] = v; applySettings(); }

$('#themeSwatches').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { settings.bg = ''; setSetting('theme', b.dataset.theme); } });
$('#customBg').addEventListener('input', e => setSetting('bg', e.target.value));
$('#clearBg').addEventListener('click', () => setSetting('bg', ''));
$('#fontSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setSetting('font', b.dataset.font); });
$('#widthSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setSetting('width', b.dataset.width); });
$('#alignSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setSetting('align', b.dataset.align); });
$('#hlColors').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setSetting('hl', b.dataset.hl); });
$('#sizeRange').addEventListener('input', e => setSetting('size', +e.target.value));
$('#sizeDown').addEventListener('click', () => setSetting('size', Math.max(13, settings.size - 1)));
$('#sizeUp').addEventListener('click', () => setSetting('size', Math.min(32, settings.size + 1)));
$('#lhRange').addEventListener('input', e => setSetting('lh', +e.target.value));
$('#wakeLock').addEventListener('change', e => { setSetting('wake', e.target.checked); updateWake(); });

/* screen wake lock */
let wakeSentinel = null;
async function updateWake() {
  try {
    if ((settings.wake || (typeof tts !== 'undefined' && tts.playing)) && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
      if (!wakeSentinel) { wakeSentinel = await navigator.wakeLock.request('screen'); wakeSentinel.addEventListener('release', () => { wakeSentinel = null; }); }
    } else if (wakeSentinel) { await wakeSentinel.release(); wakeSentinel = null; }
  } catch { /* not supported or denied */ }
}
document.addEventListener('visibilitychange', updateWake);

/* ---------------- rendering ---------------- */
const article = $('#article');
const editor = $('#editor');

function render() {
  const d = cur();
  $('#docTitle').textContent = d.title;
  document.title = d.title + ' — MD Reader';
  const { meta, body } = splitFM(d.content);
  article.innerHTML = fmHtml(meta) + (body.trim() ? mdToHtml(body) : '<p class="empty">This document is empty. Tap Edit to start writing.</p>');
  $$('a[href]', article).forEach(a => { if (!a.getAttribute('href').startsWith('#')) { a.target = '_blank'; a.rel = 'noopener'; } });
  $$('input[type="checkbox"]', article).forEach(cb => { cb.disabled = false; });
  const text = article.textContent.trim();
  const words = text ? text.split(/\s+/).length : 0;
  $('#stats').textContent = `${words.toLocaleString()} words · ${Math.max(1, Math.round(words / 230))} min read`;
  if (!$('#findbar').hidden && $('#findInput').value) runFind();
  if (tts.on) ttsRefresh();
}

function setMode(m) {
  const d = cur();
  if (mode === 'read' && m === 'edit') d.pos = scrollFraction();
  mode = m;
  $('#readView').hidden = m !== 'read';
  $('#editView').hidden = m !== 'edit';
  $('#btnMode').textContent = m === 'read' ? 'Edit' : 'Done';
  $('#btnFind').hidden = m !== 'read';
  hidePop();
  if (m === 'edit') {
    ttsStop();
    closeFind();
    editor.value = d.content;
  } else {
    render();
    requestAnimationFrame(() => restoreScroll(d.pos));
  }
}
$('#btnMode').addEventListener('click', () => setMode(mode === 'read' ? 'edit' : 'read'));

let saveTimer;
editor.addEventListener('input', () => {
  const d = cur(); d.content = editor.value; d.updated = Date.now();
  clearTimeout(saveTimer); saveTimer = setTimeout(saveDocs, 400);
});

function scrollFraction() {
  const max = document.documentElement.scrollHeight - innerHeight;
  return max > 0 ? scrollY / max : 0;
}
function restoreScroll(f) {
  const max = document.documentElement.scrollHeight - innerHeight;
  scrollTo(0, Math.round((f || 0) * max));
}
let posTimer;
addEventListener('scroll', () => {
  if (mode !== 'read') return;
  clearTimeout(posTimer);
  posTimer = setTimeout(() => { const d = cur(); if (d) { d.pos = scrollFraction(); saveDocs(); } }, 500);
}, { passive: true });

/* checkboxes in read mode toggle the source */
article.addEventListener('change', e => {
  if (e.target.type !== 'checkbox') return;
  const boxes = $$('input[type="checkbox"]', article);
  const idx = boxes.indexOf(e.target);
  const d = cur(); let n = -1;
  d.content = d.content.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/gm, (m, a, x, b) => (++n === idx ? a + (e.target.checked ? 'x' : ' ') + b : m));
  d.updated = Date.now(); saveDocs();
});

/* ---------------- title / documents drawer ---------------- */
$('#docTitle').addEventListener('click', () => {
  const d = cur(); const t = prompt('Document name', d.title);
  if (t && t.trim()) { d.title = t.trim(); d.updated = Date.now(); saveDocs(); render(); }
});

function openPanel(el) { closePanels(); $('#scrim').hidden = false; el.hidden = false; }
function closePanels() { ['#scrim', '#drawer', '#settingsSheet', '#exportSheet'].forEach(s => { $(s).hidden = true; }); }
$('#scrim').addEventListener('click', closePanels);
$$('[data-close]').forEach(b => b.addEventListener('click', closePanels));
addEventListener('keydown', e => { if (e.key === 'Escape') { closePanels(); hidePop(); } });

function fmtDate(t) {
  const d = new Date(t), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
function renderDocList() {
  const ul = $('#docList'); ul.innerHTML = '';
  [...docs].sort((a, b) => b.updated - a.updated).forEach(d => {
    const li = document.createElement('li');
    if (d.id === curId) li.className = 'cur';
    const open = document.createElement('button'); open.className = 'open';
    const b = document.createElement('b'); b.textContent = d.title;
    const sm = document.createElement('small'); sm.textContent = fmtDate(d.updated) + ' · ' + (d.content.trim() ? d.content.trim().split(/\s+/).length : 0) + ' words';
    open.append(b, sm);
    open.addEventListener('click', () => { switchDoc(d.id); closePanels(); });
    const del = document.createElement('button'); del.className = 'ib sm'; del.setAttribute('aria-label', 'Delete ' + d.title);
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
    del.addEventListener('click', () => {
      if (!confirm(`Delete “${d.title}” from this device?`)) return;
      docs = docs.filter(x => x.id !== d.id);
      if (!docs.length) newDoc('Untitled', '');
      if (curId === d.id) curId = docs[0].id;
      saveDocs(); renderDocList(); setMode('read');
    });
    li.append(open, del); ul.append(li);
  });
}
function switchDoc(id) {
  if (mode === 'read') { const d = cur(); if (d) d.pos = scrollFraction(); }
  ttsStop(); curId = id; saveDocs(); setMode('read');
}
$('#btnDocs').addEventListener('click', () => { renderDocList(); openPanel($('#drawer')); });
$('#btnNew').addEventListener('click', () => { newDoc('Untitled', ''); closePanels(); setMode('edit'); editor.focus(); });
$('#btnPaste').addEventListener('click', async () => {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { /* permission */ }
  if (!text) text = prompt('Paste your Markdown here') || '';
  if (!text.trim()) return;
  importText(text, guessTitle(text) || 'Pasted');
  closePanels();
});
$('#btnOpen').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) { await importFile(f); closePanels(); }
});
function guessTitle(text) { const fm = splitFM(text).meta; const ft = fm && fm.find(([k]) => k.toLowerCase() === 'title'); if (ft) return ft[1].slice(0, 80); const m = /^\s*#{1,3}\s+(.+)$/m.exec(text); return m ? m[1].replace(/[*_`=]/g, '').trim().slice(0, 80) : ''; }
function importText(text, title) {
  newDoc(title, text.replace(/\r\n?/g, '\n'));
  setMode('read'); scrollTo(0, 0);
  toast('Opened “' + title + '”');
}
async function importFile(f) {
  if (f.size > 5 * 1024 * 1024) { toast('That file is too large (over 5 MB).'); return; }
  const text = await f.text();
  if (/[\u0000-\u0008]/.test(text.slice(0, 2000))) { toast('That doesn’t look like a text/Markdown file.'); return; }
  importText(text, f.name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '') || guessTitle(text) || 'Imported');
}

/* drag-and-drop for desktop */
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) importFile(f); });

/* ---------------- settings & export sheets ---------------- */
$('#btnSettings').addEventListener('click', () => openPanel($('#settingsSheet')));
$('#btnExport').addEventListener('click', () => {
  $('#exportName').textContent = cur().title;
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.md', { type: 'text/markdown' })] }));
  $('#shareRow').hidden = !canShare;
  $('#useShare').checked = canShare && store.get('mdr.useShare', /Android|iPhone|iPad/i.test(navigator.userAgent));
  openPanel($('#exportSheet'));
});
$('#useShare').addEventListener('change', e => store.set('mdr.useShare', e.target.checked));

/* ---------------- find ---------------- */
let hits = [], hitIdx = -1;
function openFind() {
  if (mode !== 'read') setMode('read');
  $('#findbar').hidden = false; $('#btnFind').classList.add('on');
  const inp = $('#findInput'); inp.focus(); inp.select();
  if (inp.value) runFind();
}
function closeFind() {
  $('#findbar').hidden = true; $('#btnFind').classList.remove('on');
  clearFind(); $('#findCount').textContent = '';
}
function clearFind() {
  $$('.find-hit', article).forEach(m => m.replaceWith(...m.childNodes));
  article.normalize(); hits = []; hitIdx = -1;
}
function runFind() {
  clearFind();
  const q = $('#findInput').value;
  if (!q) { $('#findCount').textContent = ''; return; }
  const ql = q.toLowerCase();
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const low = node.data.toLowerCase();
    let i = low.indexOf(ql); if (i < 0) continue;
    let n = node;
    while (i >= 0) {
      const after = n.splitText(i); const rest = after.splitText(q.length);
      const mk = document.createElement('span'); mk.className = 'find-hit';
      after.replaceWith(mk); mk.append(after); hits.push(mk);
      n = rest; i = n.data.toLowerCase().indexOf(ql);
    }
  }
  if (hits.length) gotoHit(0); else $('#findCount').textContent = '0/0';
}
function gotoHit(i) {
  if (!hits.length) return;
  if (hitIdx >= 0) hits[hitIdx].classList.remove('cur');
  hitIdx = (i + hits.length) % hits.length;
  const h = hits[hitIdx]; h.classList.add('cur');
  const r = h.getBoundingClientRect();
  scrollTo({ top: scrollY + r.top - innerHeight / 3, behavior: 'smooth' });
  $('#findCount').textContent = `${hitIdx + 1}/${hits.length}`;
}
let findTimer;
$('#findInput').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 180); });
$('#findInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); gotoHit(hitIdx + (e.shiftKey ? -1 : 1)); $('#findInput').blur(); } });
$('#findNext').addEventListener('click', () => gotoHit(hitIdx + 1));
$('#findPrev').addEventListener('click', () => gotoHit(hitIdx - 1));
$('#findClose').addEventListener('click', closeFind);
$('#btnFind').addEventListener('click', () => ($('#findbar').hidden ? openFind() : closeFind()));
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'f' && mode === 'read') { e.preventDefault(); openFind(); } });

/* ---------------- highlighter ---------------- */
const pop = $('#hlpop');
let popTarget = null; // a <mark> element when removing
function hidePop() { pop.hidden = true; popTarget = null; }
function showPopAt(rect, removing) {
  $('#hlAdd').hidden = removing; $('#hlRemove').hidden = !removing;
  pop.hidden = false;
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let top = scrollY + rect.top - h - 10;
  if (rect.top - h - 10 < 60) top = scrollY + rect.bottom + 12; // below if too close to top (and away from native menu)
  let left = scrollX + rect.left + rect.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, scrollX + innerWidth - w - 8));
  pop.style.top = top + 'px'; pop.style.left = left + 'px';
}
function selectionInArticle() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!article.contains(r.commonAncestorContainer)) return null;
  return r;
}
let selTimer;
document.addEventListener('selectionchange', () => {
  if (mode !== 'read') return;
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    const r = selectionInArticle();
    if (r && r.toString().trim()) { popTarget = null; showPopAt(r.getBoundingClientRect(), false); }
    else if (!popTarget) hidePop();
  }, 250);
});
article.addEventListener('click', e => {
  const m = e.target.closest('mark');
  if (m && !selectionInArticle()) { popTarget = m; showPopAt(m.getBoundingClientRect(), true); }
});
document.addEventListener('pointerdown', e => { if (!pop.contains(e.target) && !e.target.closest('mark')) { popTarget = null; } }, true);
// keep the selection when tapping the popup
pop.addEventListener('pointerdown', e => e.preventDefault());
pop.addEventListener('mousedown', e => e.preventDefault());

function countOcc(hay, needle) { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; }
function nthIndex(hay, needle, n) { let i = -1; for (let k = 0; k <= n; k++) { i = hay.indexOf(needle, i + 1); if (i < 0) return -1; } return i; }

function wrapFor(text) {
  return settings.hl === 'yellow' ? `==${text}==` : `<mark class="hl-${settings.hl}">${text}</mark>`;
}
$('#hlAdd').addEventListener('click', () => {
  const r = selectionInArticle(); if (!r) return hidePop();
  const raw = r.toString();
  const sel = raw.trim();
  if (!sel) return hidePop();
  if (/\n/.test(sel)) { toast('Highlight one paragraph at a time.'); return; }
  const d = cur(); const src = d.content;
  // which occurrence of this text in the rendered page did the reader pick?
  const pre = document.createRange(); pre.setStart(article, 0); pre.setEnd(r.startContainer, r.startOffset);
  const lead = raw.length - raw.trimStart().length;
  const occ = countOcc(pre.toString() + raw.slice(0, lead), sel);
  let at = -1;
  const total = countOcc(src, sel);
  if (total === 0) {
    toast('Couldn’t highlight across formatting — try selecting plain words.');
    return;
  }
  at = nthIndex(src, sel, Math.min(occ, total - 1));
  d.content = src.slice(0, at) + wrapFor(sel) + src.slice(at + sel.length);
  d.updated = Date.now(); saveDocs();
  const y = scrollY; getSelection().removeAllRanges(); hidePop(); render(); scrollTo(0, y);
});
$('#hlRemove').addEventListener('click', () => {
  const m = popTarget; if (!m) return hidePop();
  const marks = $$('mark', article);
  const idx = marks.indexOf(m);
  const d = cur(); let n = -1;
  d.content = d.content.replace(/==(?=\S)([\s\S]*?\S)==(?!=)|<mark\b[^>]*>([\s\S]*?)<\/mark>/g, (all, a, b) => (++n === idx ? (a ?? b) : all));
  d.updated = Date.now(); saveDocs();
  const y = scrollY; hidePop(); render(); scrollTo(0, y);
});
$('#clearHl').addEventListener('click', () => {
  const d = cur();
  const before = d.content;
  d.content = before.replace(/==(?=\S)([\s\S]*?\S)==(?!=)/g, '$1').replace(/<mark\b[^>]*>([\s\S]*?)<\/mark>/g, '$1');
  if (before === d.content) { toast('No highlights in this document.'); return; }
  if (!confirm('Remove every highlight in this document?')) { d.content = before; return; }
  d.updated = Date.now(); saveDocs(); render(); toast('Highlights cleared');
});

/* ---------------- editor toolbar ---------------- */
function insert(text, selStart, selEnd) {
  editor.focus();
  const ok = document.execCommand && document.execCommand('insertText', false, text);
  if (!ok) editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
  if (selStart != null) { const base = editor.selectionEnd - text.length; editor.setSelectionRange(base + selStart, base + (selEnd ?? selStart)); }
  editor.dispatchEvent(new Event('input'));
}
function wrapSel(before, after, placeholder) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const t = editor.value.slice(s, e) || placeholder;
  insert(before + t + after, before.length, before.length + t.length);
}
function linePrefix(fn) {
  const v = editor.value;
  let s = v.lastIndexOf('\n', editor.selectionStart - 1) + 1;
  let e = v.indexOf('\n', editor.selectionEnd); if (e < 0) e = v.length;
  editor.setSelectionRange(s, e);
  const lines = v.slice(s, e).split('\n').map(fn);
  insert(lines.join('\n'));
}
const CMDS = {
  bold: () => wrapSel('**', '**', 'bold text'),
  italic: () => wrapSel('*', '*', 'italic text'),
  mark: () => (settings.hl === 'yellow' ? wrapSel('==', '==', 'highlighted') : wrapSel(`<mark class="hl-${settings.hl}">`, '</mark>', 'highlighted')),
  code: () => (editor.value.slice(editor.selectionStart, editor.selectionEnd).includes('\n') ? wrapSel('```\n', '\n```', 'code') : wrapSel('`', '`', 'code')),
  heading: () => linePrefix(l => { const m = /^(#{1,6})\s/.exec(l); if (!m) return '# ' + l; return m[1].length >= 3 ? l.replace(/^#{1,6}\s/, '') : '#' + l; }),
  ul: () => linePrefix(l => (/^\s*[-*+]\s/.test(l) ? l.replace(/^(\s*)[-*+]\s/, '$1') : '- ' + l)),
  ol: () => { let n = 0; linePrefix(l => (/^\s*\d+[.)]\s/.test(l) ? l.replace(/^(\s*)\d+[.)]\s/, '$1') : `${++n}. ` + l)); },
  task: () => linePrefix(l => (/^\s*[-*+]\s\[[ xX]\]\s/.test(l) ? l.replace(/^(\s*)[-*+]\s\[[ xX]\]\s/, '$1') : '- [ ] ' + l.replace(/^\s*[-*+]\s/, ''))),
  quote: () => linePrefix(l => (/^>\s?/.test(l) ? l.replace(/^>\s?/, '') : '> ' + l)),
  link: () => {
    const s = editor.selectionStart, e = editor.selectionEnd;
    const t = editor.value.slice(s, e) || 'link text';
    const url = prompt('Link address', 'https://'); if (!url) return;
    insert(`[${t}](${url})`, 1, 1 + t.length);
  },
  hr: () => insert('\n\n---\n\n'),
};
$('#edtools').addEventListener('pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); }); // keep keyboard open
$('#edtools').addEventListener('click', e => { const b = e.target.closest('button'); if (b) CMDS[b.dataset.cmd](); });
editor.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'b') { e.preventDefault(); CMDS.bold(); } else if (k === 'i') { e.preventDefault(); CMDS.italic(); } else if (k === 'k') { e.preventDefault(); CMDS.link(); }
});

/* ---------------- export ---------------- */
function safeName(t) { return (t || 'document').replace(/[\\/:*?"<>|]+/g, '').replace(/[. ]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document'; }
const loaded = {};
function loadScript(src) {
  return loaded[src] || (loaded[src] = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => { delete loaded[src]; rej(new Error('Could not load ' + src + ' — are you offline before the app finished caching?')); };
    document.head.append(s);
  }));
}
async function deliver(blob, filename) {
  if ($('#useShare').checked && navigator.canShare) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return; }
      catch (err) { if (err.name === 'AbortError') return; /* fall through to download */ }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Saved ' + filename);
}

const EXPORT_CSS = `
body{margin:0;background:#fff;color:#1d1d1f}
.doc{max-width:42rem;margin:0 auto;padding:2.5rem 1.25rem;font-family:${'FONTSTACK'};font-size:17px;line-height:1.6;overflow-wrap:break-word}
.doc h1,.doc h2,.doc h3,.doc h4{line-height:1.25;margin:1.4em 0 .5em}.doc h1{font-size:1.8em;margin-top:0}.doc h2{font-size:1.4em}.doc h3{font-size:1.2em}
.doc p,.doc ul,.doc ol,.doc blockquote,.doc pre,.doc table{margin:0 0 1em}.doc ul,.doc ol{padding-left:1.4em}.doc li{margin:.25em 0}
.doc li:has(>input[type=checkbox]){list-style:none;margin-left:-1.3em}
.doc a{color:#2f5bd3}.doc img{max-width:100%;height:auto}
.doc blockquote{margin-left:0;padding-left:1em;border-left:4px solid #ddd;color:#555}
.doc hr{border:0;border-top:1px solid #ddd;margin:2em 0}
.doc code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.86em;background:#f1f1f3;padding:.1em .3em;border-radius:4px}
.doc pre{background:#f4f4f6;padding:.8em 1em;border-radius:8px;overflow-x:auto}.doc pre code{background:none;padding:0}
.doc table{border-collapse:collapse}.doc th,.doc td{border:1px solid #ccc;padding:.35em .6em}.doc th{background:#f4f4f6}
.doc mark{background:#ffe36e;color:inherit;padding:0 .08em;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.doc mark.hl-green{background:#b6f0a8}.doc mark.hl-pink{background:#ffc2dc}.doc mark.hl-blue{background:#b9dcff}
@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#e4e4e6}.doc a{color:#86a8ff}.doc code,.doc pre,.doc th{background:#2a2a2d}.doc blockquote{color:#aaa;border-color:#444}.doc th,.doc td{border-color:#444}.doc mark{color:#111}}
@media print{body{background:#fff;color:#000}.doc{padding:0;max-width:none}}`;
const FONT_STACKS = {
  serif: '"Iowan Old Style",Charter,Georgia,"Times New Roman",serif', sans: 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif',
  book: '"Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif', readable: 'Verdana,Tahoma,sans-serif', mono: 'ui-monospace,Menlo,Consolas,monospace',
};
function escHtml(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
/* Exported HTML is self-contained and adjustable: A−/A+ re-flow the text to fit the screen
   (pinch-zoom only magnifies), plus theme and font toggles. Choices are remembered per file. */
function exportHtmlString(d) {
  const body = mdToHtml(splitFM(d.content).body).replace(/<input /g, '<input disabled ');
  const fonts = [settings.font, 'serif', 'sans', 'book'].filter((f, i, a) => FONT_STACKS[f] && a.indexOf(f) === i);
  const css = `
:root{--bg:#fff;--fg:#1d1d1f;--mut:#5a5a60;--line:#d9d9de;--code:#f1f1f3;--link:#2f5bd3;--fs:18px;--font:${FONT_STACKS[fonts[0]]};color-scheme:light}
:root[data-t=sepia]{--bg:#f4ecd8;--fg:#4a3b2a;--mut:#7d6a52;--line:#dccfb1;--code:#ebe0c6;--link:#9a5b13}
:root[data-t=dark]{--bg:#1c1c1e;--fg:#e4e4e6;--mut:#a0a0a6;--line:#3a3a3e;--code:#2a2a2d;--link:#86a8ff;color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-t]){--bg:#1c1c1e;--fg:#e4e4e6;--mut:#a0a0a6;--line:#3a3a3e;--code:#2a2a2d;--link:#86a8ff;color-scheme:dark}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg)}
.doc{max-width:42rem;margin:0 auto;padding:1.5rem 16px 6rem;font-family:var(--font);font-size:var(--fs);line-height:1.6;overflow-wrap:break-word;word-wrap:break-word;hyphens:auto;-webkit-hyphens:auto}
.doc h1,.doc h2,.doc h3,.doc h4{line-height:1.25;margin:1.4em 0 .5em}.doc h1{font-size:1.75em;margin-top:.4em}.doc h2{font-size:1.4em}.doc h3{font-size:1.2em}
.doc p,.doc ul,.doc ol,.doc blockquote,.doc pre,.doc table{margin:0 0 1em}.doc ul,.doc ol{padding-left:1.4em}.doc li{margin:.25em 0}
.doc li:has(>input[type=checkbox]){list-style:none;margin-left:-1.3em}
.doc a{color:var(--link)}.doc img{max-width:100%;height:auto}
.doc blockquote{margin-left:0;padding-left:1em;border-left:4px solid var(--line);color:var(--mut)}
.doc hr{border:0;border-top:1px solid var(--line);margin:2em 0}
.doc code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.86em;background:var(--code);padding:.1em .3em;border-radius:4px}
.doc pre{background:var(--code);padding:.8em 1em;border-radius:8px;white-space:pre-wrap}.doc pre code{background:none;padding:0}
.doc table{border-collapse:collapse;display:block;max-width:100%;overflow-x:auto}.doc th,.doc td{border:1px solid var(--line);padding:.35em .6em}.doc th{background:var(--code)}
.doc mark{background:#ffe36e;color:#1d1d1f;padding:0 .08em;border-radius:2px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.doc mark.hl-green{background:#b6f0a8}.doc mark.hl-pink{background:#ffc2dc}.doc mark.hl-blue{background:#b9dcff}
.rt{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));display:flex;gap:4px;padding:4px;border-radius:14px;background:var(--bg);border:1px solid var(--line);box-shadow:0 4px 16px rgba(0,0,0,.18);font:600 15px system-ui,-apple-system,Roboto,sans-serif}
.rt button{min-width:44px;height:44px;padding:0 8px;border:0;border-radius:10px;background:transparent;color:var(--fg);font:inherit;cursor:pointer}
.rt button:active{background:var(--line)}
.rt .sz{font-size:13px;color:var(--mut);align-self:center;min-width:3.2em;text-align:center}
@media print{.rt{display:none}:root{--bg:#fff;--fg:#000;--mut:#444;--link:#000}.doc{max-width:none;padding:0;font-size:12pt}}`;
  const js = `(function(){
var r=document.documentElement,K='md-export:'+document.title,F=${JSON.stringify(fonts.map(f => [f[0].toUpperCase() + f.slice(1), FONT_STACKS[f]]))},T=['','light','sepia','dark'],TL={'':'Auto',light:'Light',sepia:'Sepia',dark:'Dark'};
var s={fs:18,t:'',f:0};try{var v=JSON.parse(localStorage.getItem(K));if(v)s=v}catch(e){}
function q(id){return document.getElementById(id)}
function apply(){r.style.setProperty('--fs',s.fs+'px');if(s.t)r.setAttribute('data-t',s.t);else r.removeAttribute('data-t');
r.style.setProperty('--font',F[s.f%F.length][1]);q('rt-t').textContent=TL[s.t];q('rt-f').textContent=F[s.f%F.length][0];q('rt-s').textContent=s.fs+'px';
try{localStorage.setItem(K,JSON.stringify(s))}catch(e){}}
function size(d){var y=scrollY/Math.max(1,document.documentElement.scrollHeight-innerHeight);s.fs=Math.max(12,Math.min(44,s.fs+d));apply();scrollTo(0,y*(document.documentElement.scrollHeight-innerHeight))}
q('rt-m').onclick=function(){size(-2)};q('rt-p').onclick=function(){size(2)};
q('rt-t').onclick=function(){s.t=T[(T.indexOf(s.t)+1)%T.length];apply()};
q('rt-f').onclick=function(){s.f=(s.f+1)%F.length;apply()};
apply();})();`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(d.title)}</title>
<style>${css}</style>
</head>
<body>
<article class="doc">
${body}
</article>
<div class="rt" role="toolbar" aria-label="Text settings">
<button id="rt-m" aria-label="Smaller text">A&minus;</button><span class="sz" id="rt-s"></span><button id="rt-p" aria-label="Larger text" style="font-size:19px">A+</button><button id="rt-f" aria-label="Change font"></button><button id="rt-t" aria-label="Change theme"></button>
</div>
<script>${js}</script>
</body>
</html>
`;
}

async function exportPdf(d) {
  await loadScript('vendor/html2pdf.bundle.min.js');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:680px;background:#fff;color:#1d1d1f';
  host.innerHTML = `<style>${EXPORT_CSS.replace('FONTSTACK', FONT_STACKS[settings.font] || FONT_STACKS.serif).replace(/@media \(prefers-color-scheme:dark\)\{.*?\}\}/s, '')} .doc{padding:0;max-width:none;font-size:15px} .doc pre{white-space:pre-wrap}</style><article class="doc">${mdToHtml(splitFM(d.content).body)}</article>`;
  document.body.append(host);
  try {
    const blob = await html2pdf().set({
      margin: [0.7, 0.75, 0.7, 0.75],
      filename: safeName(d.title) + '.pdf',
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', windowWidth: 680 },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['h1', 'h2', 'h3', 'h4', 'li', 'tr', 'pre', 'blockquote', 'img'] },
    }).from(host.querySelector('.doc')).outputPdf('blob');
    await deliver(blob, safeName(d.title) + '.pdf');
  } finally { host.remove(); }
}

/* --- Markdown tokens → Word (.docx) --- */
const decoder = document.createElement('textarea');
function unescape(s) { if (!s || !/[&]/.test(s)) return s || ''; decoder.innerHTML = s; return decoder.value; }
const DOCX_HL = { yellow: 'yellow', green: 'green', pink: 'magenta', blue: 'cyan' };

async function exportDocx(d) {
  await loadScript('vendor/docx.min.js');
  const X = window.docx;
  const tokens = marked.lexer(splitFM(d.content).body);
  let numInstance = 0;

  function inline(toks, fmt = {}) {
    const out = [];
    let hlStack = [];
    for (const t of toks || []) {
      const f = Object.assign({}, fmt);
      if (hlStack.length) f.highlight = hlStack[hlStack.length - 1];
      switch (t.type) {
        case 'strong': out.push(...inline(t.tokens, { ...f, bold: true })); break;
        case 'em': out.push(...inline(t.tokens, { ...f, italics: true })); break;
        case 'del': out.push(...inline(t.tokens, { ...f, strike: true })); break;
        case 'mark': out.push(...inline(t.tokens, { ...f, highlight: 'yellow' })); break;
        case 'codespan': out.push(new X.TextRun({ ...f, text: unescape(t.text), font: 'Consolas', shading: { type: X.ShadingType.CLEAR, fill: 'F1F1F3' } })); break;
        case 'br': out.push(new X.TextRun({ ...f, break: 1 })); break;
        case 'link': {
          const kids = inline(t.tokens, { ...f, style: 'Hyperlink' });
          if (/^(https?:|mailto:)/i.test(t.href)) out.push(new X.ExternalHyperlink({ link: t.href, children: kids }));
          else out.push(...kids);
          break;
        }
        case 'image': out.push(new X.TextRun({ ...f, text: `[Image: ${unescape(t.text) || t.href}]`, italics: true, color: '666666' })); break;
        case 'html': {
          if (/^<mark\b[^>]*>$/i.test(t.raw.trim())) {
            const c = /class\s*=\s*["']?hl-(\w+)/i.exec(t.raw);
            hlStack.push(DOCX_HL[c && c[1]] || 'yellow'); break;
          }
          if (/^<\/mark>$/i.test(t.raw.trim())) { hlStack.pop(); break; }
          if (/^<br\s*\/?>$/i.test(t.raw.trim())) { out.push(new X.TextRun({ ...f, break: 1 })); break; }
          break; // drop other inline tags
        }
        case 'escape': case 'text':
          if (t.tokens && t.tokens.length) out.push(...inline(t.tokens, f));
          else out.push(new X.TextRun({ ...f, text: unescape(t.text) }));
          break;
        default:
          if (t.tokens) out.push(...inline(t.tokens, f));
          else if (t.text) out.push(new X.TextRun({ ...f, text: unescape(t.text) }));
      }
    }
    return out;
  }

  const HEADS = [X.HeadingLevel.HEADING_1, X.HeadingLevel.HEADING_2, X.HeadingLevel.HEADING_3, X.HeadingLevel.HEADING_4, X.HeadingLevel.HEADING_5, X.HeadingLevel.HEADING_6];

  function blocks(toks, ctx = {}) {
    const out = [];
    for (const t of toks) {
      const quote = ctx.quote ? { indent: { left: 567 * ctx.quote }, border: { left: { style: X.BorderStyle.SINGLE, size: 18, color: 'CCCCCC', space: 8 } } } : {};
      switch (t.type) {
        case 'heading': out.push(new X.Paragraph({ heading: HEADS[t.depth - 1], children: inline(t.tokens), ...quote })); break;
        case 'paragraph': out.push(new X.Paragraph({ children: inline(t.tokens), spacing: { after: 160 }, ...quote })); break;
        case 'text': out.push(new X.Paragraph({ children: t.tokens ? inline(t.tokens) : [new X.TextRun(unescape(t.text))], ...quote })); break;
        case 'blockquote': out.push(...blocks(t.tokens, { ...ctx, quote: (ctx.quote || 0) + 1 })); break;
        case 'code':
          t.text.split('\n').forEach((line, i, arr) => out.push(new X.Paragraph({
            children: [new X.TextRun({ text: line || ' ', font: 'Consolas', size: 19 })],
            shading: { type: X.ShadingType.CLEAR, fill: 'F4F4F6' },
            spacing: { after: i === arr.length - 1 ? 160 : 0 }, ...quote,
          })));
          break;
        case 'hr': out.push(new X.Paragraph({ children: [], border: { bottom: { style: X.BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } }, spacing: { after: 200 } })); break;
        case 'list': {
          const level = ctx.level || 0;
          const inst = t.ordered ? ++numInstance : 0;
          for (const item of t.items) {
            let first = true;
            for (const sub of item.tokens) {
              if (sub.type === 'list') { out.push(...blocks([sub], { ...ctx, level: level + 1 })); continue; }
              if (sub.type === 'space') continue;
              const kids = sub.tokens ? inline(sub.tokens) : [new X.TextRun(unescape(sub.text || ''))];
              if (first && item.task) kids.unshift(new X.TextRun((item.checked ? '☑' : '☐') + ' '));
              const listProps = first && !item.task
                ? (t.ordered ? { numbering: { reference: 'num', level: Math.min(level, 8), instance: inst } } : { bullet: { level: Math.min(level, 8) } })
                : { indent: { left: 720 * (level + 1) } };
              out.push(new X.Paragraph({ children: kids, ...listProps, ...quote }));
              first = false;
            }
          }
          break;
        }
        case 'table': {
          const cell = (c, head) => new X.TableCell({
            children: [new X.Paragraph({ children: inline(c.tokens, head ? { bold: true } : {}) })],
            shading: head ? { type: X.ShadingType.CLEAR, fill: 'F1F1F3' } : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
          });
          out.push(new X.Table({
            width: { size: 100, type: X.WidthType.PERCENTAGE },
            rows: [new X.TableRow({ tableHeader: true, children: t.header.map(c => cell(c, true)) }), ...t.rows.map(r => new X.TableRow({ children: r.map(c => cell(c)) }))],
          }));
          out.push(new X.Paragraph({ children: [] }));
          break;
        }
        case 'html': {
          const txt = unescape(t.text.replace(/<[^>]+>/g, '')).trim();
          if (txt) out.push(new X.Paragraph({ children: [new X.TextRun(txt)], ...quote }));
          break;
        }
        case 'space': break;
        default: if (t.tokens) out.push(...blocks(t.tokens, ctx));
      }
    }
    return out;
  }

  const font = { serif: 'Georgia', sans: 'Calibri', book: 'Palatino Linotype', readable: 'Verdana', mono: 'Consolas' }[settings.font] || 'Georgia';
  const doc = new X.Document({
    creator: 'MD Reader', title: d.title,
    styles: {
      default: { document: { run: { font, size: 23 }, paragraph: { spacing: { line: 300 } } } },
      paragraphStyles: [1, 2, 3, 4, 5, 6].map(n => ({
        id: 'Heading' + n, name: 'Heading ' + n, basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font, bold: true, size: [40, 32, 28, 25, 23, 23][n - 1], color: '1D1D1F' },
        paragraph: { spacing: { before: n === 1 ? 240 : 280, after: 120 }, keepNext: true },
      })),
    },
    numbering: {
      config: [{
        reference: 'num',
        levels: Array.from({ length: 9 }, (_, i) => ({
          level: i, format: [X.LevelFormat.DECIMAL, X.LevelFormat.LOWER_LETTER, X.LevelFormat.LOWER_ROMAN][i % 3],
          text: `%${i + 1}.`, alignment: X.AlignmentType.START,
          style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } },
        })),
      }],
    },
    sections: [{ properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }, children: blocks(tokens) }],
  });
  const blob = await X.Packer.toBlob(doc);
  await deliver(blob, safeName(d.title) + '.docx');
}

$('#exportSheet').addEventListener('click', async e => {
  const b = e.target.closest('[data-ex]'); if (!b) return;
  const d = cur(); const kind = b.dataset.ex; const name = safeName(d.title);
  b.disabled = true; const old = b.innerHTML; b.innerHTML = '<b>Working…</b>';
  try {
    if (kind === 'md') await deliver(new Blob([d.content], { type: 'text/markdown' }), name + '.md');
    else if (kind === 'html') await deliver(new Blob([exportHtmlString(d)], { type: 'text/html' }), name + '.html');
    else if (kind === 'pdf') await exportPdf(d);
    else if (kind === 'docx') await exportDocx(d);
    closePanels();
  } catch (err) {
    console.error(err); toast('Export failed: ' + (err.message || err));
  } finally { b.disabled = false; b.innerHTML = old; }
});
/* Send to Speechify (or any reading app): share a plain-text copy through the phone's share menu.
   Markdown symbols are removed so they aren't read aloud. */
function plainTextFor(d) {
  const host = document.createElement('div');
  host.innerHTML = mdToHtml(splitFM(d.content).body);
  const out = [];
  host.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,tr').forEach(el => {
    if (el.querySelector('p,h1,h2,h3,h4,h5,h6,pre,blockquote,table')) return; // the inner blocks are taken instead
    let t;
    if (el.tagName === 'TR') t = [...el.children].map(c => c.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ');
    else { const c = el.cloneNode(true); c.querySelectorAll('ul,ol').forEach(x => x.remove()); t = el.tagName === 'PRE' ? c.textContent.trim() : c.textContent.replace(/\s+/g, ' ').trim(); }
    if (!t) return;
    if (/^H[1-6]$/.test(el.tagName) && !/[.!?:]$/.test(t)) t += '.'; // a pause after headings
    out.push(t);
  });
  return out.join('\n\n') + '\n';
}
$('#btnSpeechify').addEventListener('click', async () => {
  const d = cur();
  const text = plainTextFor(d);
  if (!text.trim()) { toast('This document is empty.'); return; }
  const name = safeName(d.title) + '.txt';
  const file = new File([text], name, { type: 'text/plain' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: d.title });
    } else if (navigator.share) {
      await navigator.share({ title: d.title, text });
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast('Sharing isn’t available here, so the text was saved as ' + name + '. Open it in Speechify.');
      return;
    }
    closePanels();
  } catch (err) {
    if (err.name !== 'AbortError') toast('Couldn’t open the share menu: ' + (err.message || err));
  }
});

$('#btnPrint').addEventListener('click', () => {
  closePanels(); if (mode !== 'read') setMode('read'); closeFind();
  setTimeout(() => print(), 150);
});

/* ---------------- read aloud (text-to-speech) ---------------- */
const synth = window.speechSynthesis;
const tts = { on: false, playing: false, blocks: [], i: 0, c: 0, gen: 0 };
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

function blockText(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('ul,ol,input').forEach(x => x.remove());
  return c.textContent.replace(/\s+/g, ' ').trim();
}
function ttsBlocks() {
  return $$('h1,h2,h3,h4,h5,h6,p,li,pre,th,td,blockquote', article)
    .filter(el => !el.closest('.fm') && !el.classList.contains('empty') && !el.querySelector('p,h1,h2,h3,h4,h5,h6,pre,table,blockquote'))
    .map(el => ({ el, text: blockText(el) }))
    .filter(b => b.text);
}
function chunkText(text) {
  const parts = text.match(/[^.!?…]+[.!?…]*["'”’)\]]*\s*/g) || [text];
  const out = [];
  for (let p of parts) {
    while (p.length > 220) { // split very long sentences at a comma or space
      let cut = p.lastIndexOf(', ', 220); if (cut < 80) cut = p.lastIndexOf(' ', 220); if (cut < 40) cut = 220;
      out.push(p.slice(0, cut + 1)); p = p.slice(cut + 1);
    }
    if (out.length && (out[out.length - 1] + p).length < 160) out[out.length - 1] += p; else out.push(p);
  }
  return out.map(s => s.trim()).filter(Boolean);
}
function pickVoice() {
  const vs = synth.getVoices();
  return vs.find(v => v.voiceURI === settings.voice) || null;
}
function ttsMark() {
  $$('.tts-cur', article).forEach(e => e.classList.remove('tts-cur'));
  const b = tts.blocks[tts.i];
  $('#ttsPos').textContent = tts.blocks.length ? `${Math.min(tts.i + 1, tts.blocks.length)} / ${tts.blocks.length}` : '';
  if (!b) return;
  b.el.classList.add('tts-cur');
  const r = b.el.getBoundingClientRect();
  if (r.top < 70 || r.bottom > innerHeight - 120) scrollTo({ top: scrollY + r.top - innerHeight * 0.3, behavior: 'smooth' });
}
function ttsIcon() {
  $('#ttsPlayIcon').innerHTML = tts.playing ? '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>' : '<path d="M7 4l13 8-13 8z"/>';
  $('#ttsPlay').setAttribute('aria-label', tts.playing ? 'Pause' : 'Play');
  $('#ttsRate').textContent = settings.rate + '×';
}
function ttsSpeak() {
  const g = ++tts.gen;
  synth.cancel();
  const b = tts.blocks[tts.i];
  if (!b) { ttsPause(); tts.i = Math.max(0, tts.blocks.length - 1); ttsMark(); toast('Finished reading'); return; }
  ttsMark();
  const chunks = chunkText(b.text);
  if (tts.c >= chunks.length) tts.c = 0;
  const u = new SpeechSynthesisUtterance(chunks[tts.c]);
  u.rate = settings.rate;
  const v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = document.documentElement.lang || 'en-US';
  const next = () => {
    if (g !== tts.gen || !tts.playing) return;
    tts.c++; if (tts.c >= chunks.length) { tts.i++; tts.c = 0; }
    ttsSpeak();
  };
  u.onend = next;
  u.onerror = e => { if (e.error === 'interrupted' || e.error === 'canceled') return; console.warn('speech error', e.error); next(); };
  // Chrome sometimes drops an utterance queued right after cancel(); a short delay avoids it
  setTimeout(() => { if (g === tts.gen && tts.playing) synth.speak(u); }, 60);
}
function ttsPlay() { tts.playing = true; ttsIcon(); updateWake(); ttsSpeak(); }
function ttsPause() { tts.playing = false; tts.gen++; synth.cancel(); ttsIcon(); updateWake(); }
function ttsStart(fromEl) {
  if (!synth) { toast('Read-aloud isn’t supported in this browser.'); return; }
  if (mode !== 'read') setMode('read');
  closeFind();
  tts.on = true; tts.blocks = ttsBlocks(); tts.c = 0;
  if (!tts.blocks.length) { toast('Nothing to read in this document.'); tts.on = false; return; }
  let i = -1;
  if (fromEl) i = tts.blocks.findIndex(b => b.el === fromEl || b.el.contains(fromEl) || fromEl.contains(b.el));
  if (i < 0) { const top = 70; i = tts.blocks.findIndex(b => b.el.getBoundingClientRect().bottom > top); }
  tts.i = Math.max(0, i);
  $('#player').hidden = false; document.body.classList.add('listening'); $('#btnListen').classList.add('on');
  ttsPlay();
}
function ttsStop() {
  if (!tts.on) return;
  ttsPause(); tts.on = false;
  $('#player').hidden = true; document.body.classList.remove('listening'); $('#btnListen').classList.remove('on');
  $$('.tts-cur', article).forEach(e => e.classList.remove('tts-cur'));
}
function ttsRefresh() { // after the page re-renders (e.g. a new highlight)
  tts.blocks = ttsBlocks(); tts.i = Math.min(tts.i, Math.max(0, tts.blocks.length - 1));
  const b = tts.blocks[tts.i]; if (b) b.el.classList.add('tts-cur');
}
function ttsJump(d) {
  tts.i = Math.max(0, Math.min(tts.blocks.length - 1, tts.i + d)); tts.c = 0;
  if (tts.playing) ttsSpeak(); else ttsMark();
}
if (!synth) $('#btnListen').hidden = true;
$('#btnListen').addEventListener('click', () => (tts.on ? ttsStop() : ttsStart()));
$('#ttsPlay').addEventListener('click', () => (tts.playing ? ttsPause() : ttsPlay()));
$('#ttsPrev').addEventListener('click', () => ttsJump(-1));
$('#ttsNext').addEventListener('click', () => ttsJump(1));
$('#ttsClose').addEventListener('click', ttsStop);
$('#ttsRate').addEventListener('click', () => {
  settings.rate = RATES[(RATES.indexOf(settings.rate) + 1) % RATES.length] || 1;
  store.set('mdr.settings', settings); ttsIcon();
  if (tts.playing) ttsSpeak();
});
$('#hlListen').addEventListener('click', () => {
  const r = selectionInArticle();
  const node = r ? r.startContainer : null;
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  getSelection().removeAllRanges(); hidePop();
  if (tts.on) { ttsStop(); }
  ttsStart(el);
});
function fillVoices() {
  if (!synth) return;
  const sel = $('#ttsVoice'); const vs = synth.getVoices();
  const lang = (navigator.language || 'en').slice(0, 2);
  const sorted = [...vs].sort((a, b) => (b.lang.startsWith(lang) - a.lang.startsWith(lang)) || (b.localService - a.localService) || a.name.localeCompare(b.name));
  sel.innerHTML = '';
  const def = document.createElement('option'); def.value = ''; def.textContent = 'Phone’s default voice'; sel.append(def);
  for (const v of sorted) { const o = document.createElement('option'); o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`; sel.append(o); }
  sel.value = settings.voice && vs.some(v => v.voiceURI === settings.voice) ? settings.voice : '';
}
if (synth) { fillVoices(); synth.addEventListener?.('voiceschanged', fillVoices); }
$('#ttsVoice').addEventListener('change', e => { settings.voice = e.target.value; store.set('mdr.settings', settings); if (tts.playing) ttsSpeak(); });
$('#ttsTest').addEventListener('click', () => {
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance('This is how your documents will sound when read aloud.');
  u.rate = settings.rate; const v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; }
  synth.speak(u);
});
addEventListener('pagehide', () => { if (synth) synth.cancel(); });

/* ---------------- toast ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------------- hide the top bar while scrolling down ---------------- */
let lastY = scrollY;
addEventListener('scroll', () => {
  const y = scrollY;
  if (mode === 'read' && $('#findbar').hidden) $('#topbar').classList.toggle('hide', y > lastY && y > 80);
  lastY = y;
}, { passive: true });

/* ---------------- install hint, share target, service worker ---------------- */
(function installHint() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const el = $('#installHint');
  if (standalone) { el.textContent = 'Documents are stored on this device only. Export anything you want to keep elsewhere.'; return; }
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) el.innerHTML = '<b>Add to Home Screen:</b> open this page in Safari, tap the Share button, then “Add to Home Screen”.';
  else el.innerHTML = '<b>Add to Home Screen:</b> in Chrome, tap ⋮ then “Add to Home screen” or “Install app”.';
  addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    const b = document.createElement('button'); b.className = 'btn wide'; b.textContent = 'Install app on this phone';
    b.addEventListener('click', () => { e.prompt(); b.remove(); });
    el.before(b);
  });
})();

async function checkSharedFile() {
  const p = new URLSearchParams(location.search);
  if (!p.has('shared')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('mdr-share-inbox');
    const res = await cache.match('shared-file');
    if (res) {
      const name = decodeURIComponent(res.headers.get('X-Filename') || 'Shared.md');
      const text = await res.text(); await cache.delete('shared-file');
      importText(text, name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '') || 'Shared');
    }
  } catch (e) { console.error(e); }
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; // first install: nothing to refresh
    reloading = true; saveDocs(); location.reload();
  });
}

/* ---------------- boot ---------------- */
applySettings();
setMode('read');
updateWake();
checkSharedFile();
})();
