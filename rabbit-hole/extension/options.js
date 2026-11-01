import { getSettings, api } from "./lib.js";

const $ = (id) => document.getElementById(id);

(async () => {
  const s = await getSettings();
  $("server").value = s.server;
  $("token").value = s.token;
})();

$("form").onsubmit = async (e) => {
  e.preventDefault();
  let server;
  try {
    server = new URL($("server").value.trim()).origin;
  } catch {
    $("result").textContent = "That address doesn't look right.";
    return;
  }
  // ask Chrome for permission to talk to this one address only
  const granted = await chrome.permissions.request({ origins: [`${server}/*`] }).catch(() => false);
  if (!granted) {
    $("result").textContent = "The extension needs permission to reach your app. Try again and choose Allow.";
    return;
  }
  await chrome.storage.local.set({ server, token: $("token").value });
  $("result").textContent = "Testing…";
  try {
    const st = await api("/api/status");
    if (!st.authed) throw new Error("Wrong passphrase.");
    await api("/api/library");
    $("result").textContent = `Connected ✓${st.demo ? " (the app is in demo mode: no Claude API key yet)" : ""}`;
  } catch (err) {
    $("result").textContent = err.message;
  }
};
