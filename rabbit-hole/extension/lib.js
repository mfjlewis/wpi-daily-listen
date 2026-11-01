// Shared by the popup, the background worker and the options page.

export async function getSettings() {
  const { server = "", token = "" } = await chrome.storage.local.get(["server", "token"]);
  return { server: server.replace(/\/+$/, ""), token };
}

export async function api(path, { method = "GET", body } = {}) {
  const { server, token } = await getSettings();
  if (!server) throw new SetupError("Set up the extension first: add your Rabbit Hole address.");
  let res;
  try {
    res = await fetch(server + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Couldn't reach ${server}. Is the app running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new SetupError("Wrong passphrase. Check the extension's settings.");
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export class SetupError extends Error {}

export function savable(url) {
  return /^https?:\/\//i.test(url || "");
}

// Runs inside the page: returns the page as the user sees it (so logged-in
// and paywalled articles you can read get saved too) plus any selected text.
function grabPage() {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll("script:not([type='application/ld+json']), style, noscript, svg, iframe, video, audio, canvas, link[rel='stylesheet']").forEach((el) => el.remove());
  return {
    url: location.href,
    title: document.title,
    html: "<!DOCTYPE html>" + clone.outerHTML,
    selection: String(window.getSelection() || "").trim(),
  };
}

export async function capturePage(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: grabPage });
    return r?.result || null;
  } catch {
    return null; // e.g. Chrome Web Store or PDF viewer pages can't be scripted
  }
}

export async function savePage(tab, { highlight, fallbackSelection } = {}) {
  const page = await capturePage(tab.id);
  const body = { url: page?.url || tab.url };
  if (page?.html) body.html = page.html;
  const sel = highlight ?? (page?.selection || fallbackSelection);
  if (sel) body.highlight = sel;
  return api("/api/items", { method: "POST", body });
}
