import { chicagoCitation, formatDate } from "./citation.js";
import { initPlayer, playItem, playThread, playFrom, supported as ttsSupported } from "./player.js";

const view = document.getElementById("view");
let status = { demo: false, authed: true };
let pollTimer = null;
let nowPlaying = { itemId: null, paragraph: -1 };

// ---------------------------------------------------------------- utils

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/login")) {
    location.hash = "#/login";
    throw new Error("Not signed in.");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, ms = 3000) {
  document.querySelectorAll(".toast").forEach((el) => el.remove());
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

async function copy(text, html) {
  try {
    if (html && window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) }),
      ]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    toast("Copied");
  } catch {
    prompt("Copy this:", text);
  }
}

function itemTitle(i) {
  return i.citation.titleEn || i.citation.title || i.url || "Pasted text";
}

const STATUS_LABEL = {
  queued: "Waiting",
  fetching: "Downloading",
  analyzing: "Reading",
  translating: "Translating",
  filing: "Filing",
  needs_text: "Needs text",
  error: "Error",
};

function statusBadge(i) {
  if (i.status === "done") return "";
  return `<span class="status ${i.status}">${STATUS_LABEL[i.status] || i.status}</span>`;
}

function progressBar(i) {
  if (!i.paragraphCount && !i.paragraphs?.length) return "";
  const total = i.paragraphCount || i.paragraphs.length;
  const pct = i.progress.finished ? 100 : Math.round((i.progress.paragraph / total) * 100);
  return pct > 0 ? `<div class="progress" title="${pct}% listened"><div style="width:${pct}%"></div></div>` : "";
}

function itemCard(i, extra = "") {
  const c = i.citation;
  const orig = c.title && c.titleEn && c.title !== c.titleEn ? `<div class="orig">${esc(c.title)}</div>` : "";
  const bits = [c.outlet, c.authors?.join(", "), c.publishedAt && formatDate(c.publishedAt), c.languageName].filter(Boolean);
  return `<a class="card" href="#/item/${i.id}">
    <h3>${esc(itemTitle(i))} ${statusBadge(i)}</h3>${orig}
    <div class="meta">${esc(bits.join(" · "))}${i.highlightCount ? ` · ★ ${i.highlightCount}` : ""}${i.progress?.finished ? " · ✓ listened" : ""}</div>
    ${i.status !== "done" && i.statusDetail ? `<div class="meta">${esc(i.statusDetail)}…</div>` : ""}
    ${i.error ? `<div class="meta">${esc(i.error)}</div>` : ""}
    ${extra}${progressBar(i)}
  </a>`;
}

function tagChips(tags) {
  const kinds = [["people", "person"], ["places", "place"], ["organizations", "org"], ["topics", "topic"]];
  return `<div class="chips">${kinds
    .flatMap(([k, cls]) => (tags?.[k] || []).map((t) => `<a class="chip ${cls}" href="#/search?q=${encodeURIComponent(t)}">${esc(t)}</a>`))
    .join("")}</div>`;
}

function poll(fn, ms = 2500) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(fn, ms);
}

// ---------------------------------------------------------------- screenshots

async function fileToDataUrl(file, maxDim = 2000) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

function pickScreenshots(itemId) {
  const input = document.getElementById("shotInput");
  input.value = "";
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    toast(`Reading ${files.length} screenshot${files.length > 1 ? "s" : ""}…`, 4000);
    let placed = 0;
    for (const f of files) {
      try {
        const image = await fileToDataUrl(f);
        let r = await api("/api/screenshots", { method: "POST", body: { image, itemId } });
        if (!r.itemId && !r.demo) {
          const choice = await chooseItemFor(r.ocr);
          if (choice) r = await api("/api/screenshots", { method: "POST", body: { image, itemId: choice, ocr: r.ocr } });
        }
        if (r.demo) toast(r.message, 5000);
        else if (r.itemId) placed++;
      } catch (e) {
        toast(e.message, 5000);
      }
    }
    if (placed) toast(`Added ${placed} highlight${placed > 1 ? "s" : ""}`);
    route();
  };
  input.click();
}

async function chooseItemFor(ocr) {
  const { items } = await api("/api/library");
  const done = items.filter((i) => i.status === "done");
  if (!done.length) {
    toast("Save the article first, then add its screenshots.", 5000);
    return null;
  }
  const list = done.slice(0, 30).map((i, n) => `${n + 1}. ${itemTitle(i)}`).join("\n");
  const preview = (ocr?.english || ocr?.text || "").slice(0, 160);
  const ans = prompt(`Couldn't tell which article this screenshot is from:\n“${preview}…”\n\nType the number of the article:\n${list}`);
  const n = Number(ans);
  return n >= 1 && n <= done.length ? done[n - 1].id : null;
}

// ---------------------------------------------------------------- views

async function viewLogin(params) {
  view.innerHTML = `<div class="card" style="max-width:24rem;margin:3rem auto">
    <h1>Rabbit Hole</h1>
    <p class="muted">Enter your passphrase.</p>
    <form id="loginForm"><input type="password" name="token" autocomplete="current-password" required>
    <div class="row" style="margin-top:.6rem"><button class="primary">Sign in</button></div></form></div>`;
  document.getElementById("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/login", { method: "POST", body: { token: e.target.token.value } });
      status.authed = true;
      const next = params.get("next");
      if (next && next.startsWith("/share")) location.href = next;
      else location.hash = "#/";
    } catch (err) {
      toast(err.message);
    }
  };
}

async function viewLibrary(params) {
  const { threads, items } = await api("/api/library");
  const working = items.filter((i) => i.status !== "done");
  const unthreaded = items.filter((i) => i.status === "done" && !i.threadId);
  if (params.get("error")) toast(params.get("error"), 5000);

  view.innerHTML = `
    <form class="card add" id="addForm">
      <textarea name="input" placeholder="Paste a link to save it. (If a site blocks downloads, paste the article text with its link.)" rows="2"></textarea>
      <div class="row">
        <button class="primary">Save</button>
        <button type="button" id="addShots">Add screenshots</button>
        <span class="grow"></span>
        <span class="muted small">${items.length} source${items.length === 1 ? "" : "s"} · ${threads.length} thread${threads.length === 1 ? "" : "s"}</span>
      </div>
    </form>
    ${working.length ? `<h2>In progress</h2>${working.map((i) => itemCard(i)).join("")}` : ""}
    <h2>Research threads</h2>
    ${threads.length ? threads.map(threadCard).join("") : `<div class="empty">Nothing here yet. Save a link above and it will be translated, tagged and filed into a thread automatically.</div>`}
    ${unthreaded.length ? `<h2>Not filed yet</h2>${unthreaded.map((i) => itemCard(i)).join("")}` : ""}
    ${items.length ? `<details style="margin-top:2rem"><summary>All sources (${items.length})</summary>${items.map((i) => itemCard(i)).join("")}</details>` : ""}
    <p class="muted small" style="margin-top:2rem"><a href="/api/export">Download everything (JSON)</a></p>`;

  document.getElementById("addForm").onsubmit = async (e) => {
    e.preventDefault();
    const text = e.target.input.value.trim();
    if (!text) return;
    try {
      const r = await api("/api/items", { method: "POST", body: { text } });
      if (r.duplicate) {
        toast("Already saved, so I've opened it.");
        location.hash = `#/item/${r.item.id}`;
        return;
      }
      e.target.input.value = "";
      toast("Saved. Processing in the background.");
      route();
    } catch (err) {
      toast(err.message, 5000);
    }
  };
  document.getElementById("addShots").onclick = () => pickScreenshots(null);
  if (working.some((i) => !["error", "needs_text"].includes(i.status))) poll(route);
}

function threadCard(t) {
  return `<a class="card" href="#/thread/${t.id}">
    <h3>${esc(t.title)}</h3>
    <div class="meta">${t.count} source${t.count === 1 ? "" : "s"}${t.languages.length ? ` · ${esc(t.languages.join(", "))}` : ""}${t.highlightCount ? ` · ★ ${t.highlightCount}` : ""} · ${t.finished}/${t.count} listened · last added ${formatDate(t.lastSaved.slice(0, 10))}</div>
    ${t.summary ? `<p style="margin:.4rem 0 0">${esc(t.summary)}</p>` : ""}
  </a>`;
}

async function viewThread(id) {
  const { thread: t, items, highlights, citations, threads } = await api(`/api/threads/${id}`);
  const firstUnfinished = items.find((i) => !i.progress.finished && i.status === "done") || items[0];
  view.innerHTML = `
    <p class="small"><a href="#/">← Library</a></p>
    <h1 id="tTitle">${esc(t.title)}</h1>
    <div class="row"><button class="small" id="rename">Rename</button>
      ${ttsSupported() ? `<button class="primary" id="playAll">▶ ${firstUnfinished && firstUnfinished !== items[0] ? "Resume" : "Play"} thread</button>` : ""}
      <button class="small" id="addShots">Add screenshots</button></div>
    <p>${esc(t.summary)}</p>
    <div class="meta">${t.count} sources · ${t.finished} listened · started ${formatDate(t.createdAt.slice(0, 10))}</div>

    <h2>Sources</h2>
    ${items.map((i) => itemCard(i)).join("")}
    <form id="addHere" class="row" style="margin-top:.5rem"><input type="url" name="url" placeholder="Add a link to this thread" class="grow"><button>Add</button></form>

    ${highlights.length ? `<h2>Highlights</h2>${highlights.map((h) => highlightCard(h, true)).join("")}` : ""}

    <h2>Notes</h2>
    <textarea id="notes" placeholder="What were you trying to find out? Leads, open questions, story ideas…">${esc(t.notes || "")}</textarea>

    <h2>Citations</h2>
    <div class="card">
      ${citations.map((c) => `<p class="citation">${chicagoCitation(c.citation)}</p>`).join("")}
      <button id="copyCites">Copy all citations</button>
    </div>

    ${threads.length ? `<details style="margin-top:1.5rem"><summary>Merge this thread into another</summary>
      <div class="row" style="margin-top:.5rem"><select id="mergeInto" class="grow">${threads.map((x) => `<option value="${x.id}">${esc(x.title)}</option>`).join("")}</select>
      <button id="merge">Merge</button></div></details>` : ""}`;

  document.getElementById("rename").onclick = async () => {
    const title = prompt("Thread title", t.title);
    if (title && title.trim()) {
      await api(`/api/threads/${id}`, { method: "PATCH", body: { title } });
      route();
    }
  };
  const playBtn = document.getElementById("playAll");
  if (playBtn) playBtn.onclick = () => playThread(items.filter((i) => i.status === "done").map((i) => i.id), firstUnfinished?.id);
  document.getElementById("addShots").onclick = () => pickScreenshots(null);
  let notesTimer;
  document.getElementById("notes").oninput = (e) => {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => api(`/api/threads/${id}`, { method: "PATCH", body: { notes: e.target.value } }), 800);
  };
  document.getElementById("copyCites").onclick = () =>
    copy(
      citations.map((c) => chicagoCitation(c.citation, { plain: true })).join("\n\n"),
      citations.map((c) => `<p>${chicagoCitation(c.citation)}</p>`).join(""),
    );
  document.getElementById("addHere").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/items", { method: "POST", body: { url: e.target.url.value, threadId: id } });
      toast(r.duplicate ? "Already saved." : "Saved. Processing in the background.");
      route();
    } catch (err) {
      toast(err.message);
    }
  };
  const merge = document.getElementById("merge");
  if (merge) merge.onclick = async () => {
    const into = document.getElementById("mergeInto").value;
    if (!confirm("Move all sources into that thread and remove this one?")) return;
    await api(`/api/threads/${id}/merge`, { method: "POST", body: { into } });
    location.hash = `#/thread/${into}`;
  };
  bindHighlightButtons();
  if (items.some((i) => !["done", "error", "needs_text"].includes(i.status))) poll(route);
}

function highlightCard(h, withSource = false) {
  const differs = h.quoteEn && h.quoteEn.trim() !== h.quoteOrig?.trim();
  const itemId = h.itemId || currentItemId;
  return `<div class="card highlight-card">
    ${withSource ? `<div class="meta"><a href="#/item/${h.itemId}">${esc(h.itemTitle)}</a> · ¶${h.paragraph + 1}</div>` : `<div class="meta">${h.paragraphs?.length === 0 && h.screenshot ? "Screenshot" : `¶${h.paragraph + 1}`}</div>`}
    ${h.quoteOrig ? `<blockquote>${esc(h.quoteOrig)}</blockquote>` : ""}
    ${differs ? `<div class="en">EN (machine translation): ${esc(h.quoteEn)}</div>` : ""}
    ${h.screenshot ? `<a href="/files/${itemId}/${h.screenshot}" target="_blank"><img src="/files/${itemId}/${h.screenshot}" alt="Screenshot" loading="lazy"></a>` : ""}
    ${h.note ? `<p class="small" style="margin:.4rem 0 0">📝 ${esc(h.note)}</p>` : ""}
    <div class="row" style="margin-top:.4rem">
      <button class="small" data-hl-note="${h.id}" data-item="${itemId}">Note</button>
      <button class="small" data-hl-del="${h.id}" data-item="${itemId}">Remove</button>
    </div></div>`;
}

let currentItemId = null;

function bindHighlightButtons() {
  view.querySelectorAll("[data-hl-note]").forEach((b) => {
    b.onclick = async () => {
      const note = prompt("Note for this highlight");
      if (note == null) return;
      await api(`/api/items/${b.dataset.item}/highlights/${b.dataset.hlNote}`, { method: "PATCH", body: { note } });
      route();
    };
  });
  view.querySelectorAll("[data-hl-del]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Remove this highlight?")) return;
      await api(`/api/items/${b.dataset.item}/highlights/${b.dataset.hlDel}`, { method: "DELETE" });
      route();
    };
  });
}

let textMode = localStorage.getItem("rh.textMode") || "en";

async function viewItem(id, params) {
  currentItemId = id;
  const { item, thread, threads } = await api(`/api/items/${id}`);
  const c = item.citation;
  const translated = item.paragraphs.some((p) => p.en && p.en !== p.orig);
  if (params.get("duplicate")) toast("You'd already saved this one.");
  const hlParas = new Set(item.highlights.flatMap((h) => (Array.isArray(h.paragraphs) ? h.paragraphs : [h.paragraph])));

  let statusBlock = "";
  if (item.status === "needs_text") {
    statusBlock = `<div class="card" style="background:var(--err)"><strong>Couldn't get the text.</strong> ${esc(item.error)}
      <form id="pasteForm"><textarea name="text" placeholder="Open the page in your browser, select all the article text, copy it and paste it here." style="margin-top:.5rem"></textarea>
      <div class="row" style="margin-top:.5rem"><button class="primary">Use this text</button></div></form></div>`;
  } else if (item.status === "error") {
    statusBlock = `<div class="card" style="background:var(--err)"><strong>Something went wrong.</strong> ${esc(item.error)} <button class="small" id="retry">Try again</button></div>`;
  } else if (item.status !== "done") {
    statusBlock = `<div class="card" style="background:var(--warn)">${STATUS_LABEL[item.status] || item.status}… ${esc(item.statusDetail || "")}</div>`;
  }

  const archive =
    c.archiveUrl
      ? `<a href="${esc(c.archiveUrl)}" target="_blank" rel="noopener">Wayback Machine copy</a>`
      : c.archiveStatus === "working" || c.archiveStatus === "pending"
        ? `<span class="muted">archiving…</span>`
        : item.url
          ? `<span class="muted">not archived</span> <button class="small" id="archiveBtn">Try again</button>`
          : `<span class="muted">pasted text, no link</span>`;

  view.innerHTML = `
    <p class="small">${thread ? `<a href="#/thread/${thread.id}">← ${esc(thread.title)}</a>` : `<a href="#/">← Library</a>`}</p>
    ${statusBlock}
    <h1>${esc(itemTitle(item))}</h1>
    ${c.title && c.titleEn && c.title !== c.titleEn ? `<p class="muted" style="margin-top:0;font-family:var(--serif)">${esc(c.title)}</p>` : ""}
    <div class="row">
      ${ttsSupported() && item.paragraphs.length ? `<button class="primary" id="play">▶ ${item.progress.paragraph > 0 && !item.progress.finished ? `Resume (¶${item.progress.paragraph + 1})` : "Listen"}</button>` : ""}
      <button id="copyCite">Copy citation</button>
      <button id="addShot">Add screenshot</button>
    </div>

    <div class="card">
      <dl class="facts">
        <dt>Author</dt><dd>${esc(c.authors?.join("; ") || "—")}</dd>
        <dt>Outlet</dt><dd>${esc(c.outlet || "—")}</dd>
        <dt>Published</dt><dd>${esc(c.publishedAt ? formatDate(c.publishedAt) : "unknown")}</dd>
        <dt>Language</dt><dd>${esc(c.languageName || "—")}</dd>
        <dt>Link</dt><dd>${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.url)}</a>` : "—"}</dd>
        <dt>Archive</dt><dd>${archive}</dd>
        <dt>Saved</dt><dd>${formatDate(item.savedAt.slice(0, 10))}</dd>
      </dl>
      <p class="citation">${chicagoCitation(c)}</p>
      <details><summary>Fix citation details</summary>
        <form id="citeForm" style="display:grid;gap:.4rem;margin-top:.5rem">
          <label>Original title <input type="text" name="title" value="${esc(c.title)}"></label>
          <label>English title <input type="text" name="titleEn" value="${esc(c.titleEn)}"></label>
          <label>Authors (separate with ;) <input type="text" name="authors" value="${esc((c.authors || []).join("; "))}"></label>
          <label>Outlet <input type="text" name="outlet" value="${esc(c.outlet)}"></label>
          <label>Published (YYYY-MM-DD) <input type="text" name="publishedAt" value="${esc(c.publishedAt)}"></label>
          <div><button class="primary">Save</button></div>
        </form>
      </details>
    </div>

    <div class="row small">
      <span class="muted">Thread:</span>
      <select id="threadSel" style="width:auto;max-width:100%">
        ${threads.map((t) => `<option value="${t.id}" ${t.id === item.threadId ? "selected" : ""}>${esc(t.title)}</option>`).join("")}
        ${item.threadId ? "" : `<option value="" selected>(not filed)</option>`}
        <option value="new">+ New thread…</option>
        <option value="auto">Let Claude re-file it</option>
      </select>
    </div>
    ${item.summary ? `<p>${esc(item.summary)}</p>` : ""}
    ${tagChips(item.tags)}

    ${item.highlights.length ? `<h2>Highlights</h2>${item.highlights.map((h) => highlightCard(h)).join("")}` : ""}

    ${item.paragraphs.length ? `
      <div class="tabs" role="group" aria-label="Text view">
        ${translated ? `<button data-mode="en">English</button><button data-mode="orig">Original</button><button data-mode="side">Side by side</button>` : `<button data-mode="en">Text</button>`}
        <button data-mode="listen">Listening script</button>
      </div>
      ${translated && textMode !== "orig" ? `<p class="mt-note">English is a machine translation. Check the original before quoting.</p>` : ""}
      <div class="text" id="text">${renderParagraphs(item, hlParas, translated)}</div>` : ""}

    <details style="margin-top:2rem"><summary>More</summary>
      <div class="row" style="margin-top:.5rem">
        <button id="reprocess">Re-run translation &amp; tagging</button>
        <button id="delete">Delete this source</button>
      </div>
    </details>`;

  // wire up
  const playBtn = document.getElementById("play");
  if (playBtn) playBtn.onclick = () => playItem(id);
  document.getElementById("copyCite").onclick = () => copy(chicagoCitation(c, { plain: true }), chicagoCitation(c));
  document.getElementById("addShot").onclick = () => pickScreenshots(id);
  view.querySelectorAll(".tabs button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.mode === textMode || (!translated && textMode !== "listen" && b.dataset.mode === "en")));
    b.onclick = () => {
      textMode = b.dataset.mode;
      localStorage.setItem("rh.textMode", textMode);
      viewItem(id, new URLSearchParams());
    };
  });
  view.querySelectorAll("[data-play]").forEach((b) => (b.onclick = () => playFrom(id, Number(b.dataset.play))));
  view.querySelectorAll("[data-star]").forEach((b) => {
    b.onclick = async () => {
      const i = Number(b.dataset.star);
      const existing = item.highlights.find((h) => h.paragraph === i && !h.screenshot);
      if (existing) await api(`/api/items/${id}/highlights/${existing.id}`, { method: "DELETE" });
      else await api(`/api/items/${id}/highlights`, { method: "POST", body: { paragraph: i } });
      viewItem(id, new URLSearchParams());
    };
  });
  bindHighlightButtons();
  document.getElementById("threadSel").onchange = async (e) => {
    let body = { threadId: e.target.value };
    if (body.threadId === "new") {
      const title = prompt("Name the new thread");
      if (!title) return route();
      body.newThreadTitle = title;
    }
    if (!body.threadId) return;
    try {
      await api(`/api/items/${id}`, { method: "PATCH", body });
      toast("Moved.");
    } catch (err) {
      toast(err.message);
    }
    route();
  };
  document.getElementById("citeForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    await api(`/api/items/${id}`, {
      method: "PATCH",
      body: {
        citation: {
          title: f.title.value.trim(),
          titleEn: f.titleEn.value.trim(),
          authors: f.authors.value.split(";").map((s) => s.trim()).filter(Boolean),
          outlet: f.outlet.value.trim(),
          publishedAt: f.publishedAt.value.trim(),
        },
      },
    });
    toast("Citation updated.");
    route();
  };
  document.getElementById("reprocess").onclick = async () => {
    if (!confirm("Re-download (if possible), re-translate and re-tag this source? Highlights are kept.")) return;
    await api(`/api/items/${id}/reprocess`, { method: "POST" });
    route();
  };
  document.getElementById("delete").onclick = async () => {
    if (!confirm("Delete this source and its highlights and screenshots?")) return;
    await api(`/api/items/${id}`, { method: "DELETE" });
    location.hash = thread ? `#/thread/${thread.id}` : "#/";
  };
  const paste = document.getElementById("pasteForm");
  if (paste) paste.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/items/${id}/text`, { method: "POST", body: { text: e.target.text.value } });
      route();
    } catch (err) {
      toast(err.message);
    }
  };
  const retry = document.getElementById("retry");
  if (retry) retry.onclick = async () => {
    await api(`/api/items/${id}/reprocess`, { method: "POST" });
    route();
  };
  const arch = document.getElementById("archiveBtn");
  if (arch) arch.onclick = async () => {
    await api(`/api/items/${id}/archive`, { method: "POST" });
    toast("Asking the Wayback Machine… this can take a minute.");
    poll(route, 4000);
  };
  markNowPlaying();
  if (!["done", "error", "needs_text"].includes(item.status) || ["working", "pending"].includes(c.archiveStatus)) poll(route, item.status === "done" ? 6000 : 2500);
}

function renderParagraphs(item, hlParas, translated) {
  const mode = !translated && textMode !== "listen" ? "en" : textMode;
  return item.paragraphs
    .map((p, i) => {
      let body;
      if (mode === "orig") body = esc(p.orig);
      else if (mode === "side") body = `<div class="side"><div lang="${esc(item.citation.language)}">${esc(p.orig)}</div><div>${esc(p.en)}</div></div>`;
      else if (mode === "listen") body = p.listen ? esc(p.listen) : `<span class="muted small">(skipped when listening)</span>`;
      else body = esc(p.en || p.orig);
      return `<div class="para ${hlParas.has(i) ? "highlighted" : ""}" id="p${i}" data-i="${i}">
        <div class="tools"><button data-play="${i}" title="Listen from here">¶${i + 1}</button><button data-star="${i}" title="Highlight">${hlParas.has(i) ? "★" : "☆"}</button></div>
        ${body}</div>`;
    })
    .join("");
}

function markNowPlaying() {
  view.querySelectorAll(".para.now").forEach((el) => el.classList.remove("now"));
  if (nowPlaying.itemId && nowPlaying.itemId === currentItemId) {
    const el = document.getElementById(`p${nowPlaying.paragraph}`);
    if (el) {
      el.classList.add("now");
      const r = el.getBoundingClientRect();
      if (r.top < 60 || r.bottom > window.innerHeight - 130) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

async function viewSearch(params) {
  const q = params.get("q") || "";
  document.getElementById("searchBox").value = q;
  view.innerHTML = `<p class="small"><a href="#/">← Library</a></p><h1>Searching for “${esc(q)}”…</h1>`;
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    view.innerHTML = `<p class="small"><a href="#/">← Library</a></p>
      <h1>${results.length} result${results.length === 1 ? "" : "s"} for “${esc(q)}”</h1>
      ${results.map((r) => itemCard(r, `<div class="meta">${r.threadTitle ? `🧵 ${esc(r.threadTitle)} · ` : ""}<em>${esc(r.reason)}</em></div>`)).join("") || `<div class="empty">Nothing in your archive matches that.</div>`}`;
  } catch (e) {
    view.innerHTML = `<p class="small"><a href="#/">← Library</a></p><div class="card">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------- router

async function route() {
  clearTimeout(pollTimer);
  const hash = location.hash.slice(1) || "/";
  const [path, query] = hash.split("?");
  const params = new URLSearchParams(query || "");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "item") currentItemId = null;
  try {
    if (parts[0] === "login") return await viewLogin(params);
    if (!status.authed) {
      location.hash = "#/login";
      return;
    }
    if (parts[0] === "thread") return await viewThread(parts[1]);
    if (parts[0] === "item") return await viewItem(parts[1], params);
    if (parts[0] === "search") return await viewSearch(params);
    return await viewLibrary(params);
  } catch (e) {
    if (e.message !== "Not signed in.") view.innerHTML = `<div class="card">${esc(e.message)} <a href="#/">Back to library</a></div>`;
  }
}

// keep scroll position on in-place refreshes; reset it on navigation
let lastPath = "";
window.addEventListener("hashchange", () => {
  const p = location.hash.split("?")[0];
  if (p !== lastPath) window.scrollTo(0, 0);
  lastPath = p;
  route();
});

document.getElementById("searchForm").onsubmit = (e) => {
  e.preventDefault();
  const q = document.getElementById("searchBox").value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
};

document.addEventListener("rh:ttserror", (e) => {
  toast(`This device's speech engine isn't working (${e.detail.error}). Check that a text-to-speech voice is installed.`, 6000);
});

document.addEventListener("rh:now", (e) => {
  nowPlaying = e.detail;
  markNowPlaying();
});

initPlayer({
  getItem: async (id) => (await api(`/api/items/${id}`)).item,
  saveProgress: (id, paragraph, finished) =>
    api(`/api/items/${id}/progress`, { method: "PUT", body: { paragraph, finished } }).catch(() => {}),
});

(async () => {
  try {
    status = await fetch("/api/status").then((r) => r.json());
  } catch {}
  const banner = document.getElementById("banner");
  if (status.demo) {
    banner.hidden = false;
    banner.textContent = "Demo mode: no Claude API key is set, so translations, tags and search are rough stand-ins.";
  } else if (!ttsSupported()) {
    banner.hidden = false;
    banner.textContent = "This browser has no built-in speech, so listening is unavailable here.";
  }
  lastPath = location.hash.split("?")[0];
  route();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
