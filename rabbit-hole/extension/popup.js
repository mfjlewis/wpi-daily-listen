import { api, getSettings, savePage, savable, SetupError } from "./lib.js";

const $ = (id) => document.getElementById(id);
const LABEL = {
  queued: "Waiting…",
  fetching: "Reading the page…",
  analyzing: "Finding citation details and tags…",
  translating: "Translating…",
  filing: "Filing into a research thread…",
};

$("settings").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

async function activeTab() {
  // ?tab=<id> lets the popup be opened as a normal page (used in tests)
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  if (forced) return chrome.tabs.get(forced);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function show(state, title = "", detail = "") {
  $("state").textContent = state;
  $("title").textContent = title;
  $("detail").textContent = detail;
}

async function watch(id, server, headline) {
  $("actions").hidden = false;
  $("open").onclick = () => chrome.tabs.create({ url: `${server}/#/item/${id}` });
  for (let n = 0; n < 120; n++) {
    let item, thread;
    try {
      ({ item, thread } = await api(`/api/items/${id}`));
    } catch {
      return;
    }
    const title = item.citation.titleEn || item.citation.title || item.url;
    if (item.status === "done") {
      const hl = item.highlights.length ? ` · ★ ${item.highlights.length} highlight${item.highlights.length > 1 ? "s" : ""}` : "";
      show(headline, title, `${thread ? `Thread: ${thread.title}` : ""}${hl}`);
      return;
    }
    if (item.status === "needs_text" || item.status === "error") {
      show("Saved, but needs attention", title, item.error);
      return;
    }
    show(headline, title, LABEL[item.status] || "Processing…");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function main() {
  const { server } = await getSettings();
  const tab = await activeTab();
  if (!savable(tab?.url)) {
    show("Can't save this page", "", "Only ordinary web pages can be saved.");
    return;
  }
  try {
    const r = await savePage(tab);
    const headline = r.duplicate ? "Already in your archive" : "Saved ✓";
    show(headline, r.item.citation.titleEn || tab.title, "");
    $("shot").onclick = () => screenshot(tab, r.item.id);
    watch(r.item.id, server, headline);
  } catch (e) {
    show(e instanceof SetupError ? "Almost there" : "Couldn't save", "", e.message);
    if (e instanceof SetupError) {
      $("actions").hidden = false;
      $("shot").hidden = true;
      $("open").textContent = "Open settings";
      $("open").onclick = () => chrome.runtime.openOptionsPage();
    }
  }
}

async function screenshot(tab, itemId) {
  $("shot").disabled = true;
  $("shot").textContent = "Reading screenshot…";
  try {
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
    const r = await api("/api/screenshots", { method: "POST", body: { image, itemId } });
    $("shot").textContent = r.demo ? "Screenshots need an API key" : r.matched ? "Highlight added ✓" : "Screenshot saved (passage not located)";
  } catch (e) {
    $("shot").textContent = e.message;
  }
}

main();
