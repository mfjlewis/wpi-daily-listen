import { api, savePage, savable, SetupError } from "./lib.js";

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "rh-page", title: "Save page to Rabbit Hole", contexts: ["page"] });
    chrome.contextMenus.create({ id: "rh-selection", title: "Save selection to Rabbit Hole as a highlight", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "rh-link", title: "Save link to Rabbit Hole", contexts: ["link"] });
  });
  if (reason === "install") chrome.runtime.openOptionsPage();
});

async function flash(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === "rh-link") {
      if (!savable(info.linkUrl)) throw new Error("Only web links can be saved.");
      await api("/api/items", { method: "POST", body: { url: info.linkUrl } });
    } else {
      if (!savable(tab?.url)) throw new Error("This page can't be saved.");
      await savePage(tab, info.menuItemId === "rh-selection" ? { fallbackSelection: info.selectionText } : { highlight: "" });
    }
    flash("✓", "#2e7d32");
  } catch (e) {
    console.warn(e);
    flash("!", "#c62828");
    if (e instanceof SetupError) chrome.runtime.openOptionsPage();
  }
});
