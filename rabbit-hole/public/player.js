// Listening player built on the browser's speech synthesis.
// Reads the "listen" version of each paragraph, remembers where you stopped,
// and can play a whole research thread back to back.
//
// Speech is chunked by sentence: some browsers stop long utterances early.

const $ = (id) => document.getElementById(id);
const synth = window.speechSynthesis;

const state = {
  queue: [], // item ids still to play (thread mode)
  item: null,
  para: 0,
  sentences: [],
  sent: 0,
  playing: false,
  token: 0, // bumps on every jump so stale "end" callbacks are ignored
  rate: Number(localStorage.getItem("rh.rate") || 1),
  voiceName: localStorage.getItem("rh.voice") || "",
  original: localStorage.getItem("rh.original") === "1",
  wakeLock: null,
  saveTimer: null,
  errors: 0, // consecutive speech errors; stop rather than skip through the article
};

let api; // injected by app.js: { getItem(id), saveProgress(id, paragraph, finished) }

export function initPlayer(deps) {
  api = deps;
  $("pPlay").onclick = toggle;
  $("pNext").onclick = () => jump(state.para + 1);
  $("pPrev").onclick = () => jump(Math.max(0, state.para - (state.sent > 0 ? 0 : 1)));
  $("pClose").onclick = stop;
  $("pSettings").onclick = () => ($("playerSettings").hidden = !$("playerSettings").hidden);
  $("pRate").value = String(state.rate);
  $("pRate").onchange = (e) => {
    state.rate = Number(e.target.value);
    localStorage.setItem("rh.rate", state.rate);
    if (state.playing) restartSentence();
  };
  $("pVoice").onchange = (e) => {
    state.voiceName = e.target.value;
    localStorage.setItem("rh.voice", state.voiceName);
    if (state.playing) restartSentence();
  };
  $("pOriginal").checked = state.original;
  $("pOriginal").onchange = (e) => {
    state.original = e.target.checked;
    localStorage.setItem("rh.original", state.original ? "1" : "0");
    if (state.item) jump(state.para);
  };
  fillVoices();
  if (synth) synth.onvoiceschanged = fillVoices;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.playing) requestWakeLock();
  });
}

export function supported() {
  return !!synth;
}

function voicesFor(lang) {
  const all = synth?.getVoices() || [];
  const prefix = (lang || "en").slice(0, 2).toLowerCase();
  return all.filter((v) => v.lang.toLowerCase().startsWith(prefix));
}

function fillVoices() {
  const sel = $("pVoice");
  const en = voicesFor("en");
  sel.innerHTML = `<option value="">Default English voice</option>` +
    en.map((v) => `<option value="${v.name.replace(/"/g, "&quot;")}">${v.name}${v.localService ? "" : " (online)"}</option>`).join("");
  sel.value = en.some((v) => v.name === state.voiceName) ? state.voiceName : "";
}

function pickVoice(lang) {
  const list = voicesFor(lang);
  if (!state.original || /^en/i.test(lang)) {
    const chosen = list.find((v) => v.name === state.voiceName);
    if (chosen) return chosen;
  }
  // prefer higher-quality online/"natural" voices when available
  return list.find((v) => /natural|neural|google|premium|enhanced/i.test(v.name)) || list[0] || null;
}

function splitSentences(text) {
  const rough = text.match(/[^.!?…]+(?:[.!?…]+["»”’)\]]*|$)\s*/g) || [text];
  const out = [];
  for (let s of rough) {
    s = s.trim();
    while (s.length > 240) {
      let cut = s.lastIndexOf(", ", 220);
      if (cut < 80) cut = s.lastIndexOf(" ", 220);
      if (cut < 40) cut = 220;
      out.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

function paraText(item, i) {
  const p = item.paragraphs[i];
  if (!p) return "";
  if (state.original) return p.orig;
  return p.listen ?? p.en ?? p.orig;
}

function speechLang(item) {
  return state.original ? item.citation.language || "en" : "en";
}

function title(item) {
  return item.citation.titleEn || item.citation.title || item.url;
}

// ---------------------------------------------------------------- public API

export async function playItem(id, fromParagraph) {
  state.queue = [];
  await load(id, fromParagraph);
}

export async function playThread(ids, startId) {
  const start = Math.max(0, ids.indexOf(startId));
  const ordered = ids.slice(start);
  state.queue = ordered.slice(1);
  await load(ordered[0], undefined, { announce: true });
}

export function currentItemId() {
  return state.item?.id || null;
}

// ---------------------------------------------------------------- internals

async function load(id, fromParagraph, { announce = false } = {}) {
  const item = await api.getItem(id);
  if (!item || !item.paragraphs.length) return next();
  state.item = item;
  let start = fromParagraph ?? (item.progress.finished ? 0 : item.progress.paragraph || 0);
  if (start >= item.paragraphs.length) start = 0;
  state.para = start;
  $("player").hidden = false;
  render();
  state.playing = true;
  requestWakeLock();
  if (announce || (fromParagraph === undefined && start === 0)) {
    const intro = [title(item), item.citation.outlet && `from ${item.citation.outlet}`].filter(Boolean).join(", ");
    speakIntro(`${intro}.`, () => startParagraph(start));
  } else {
    startParagraph(start);
  }
}

function speakIntro(text, then) {
  if (!synth) return then();
  const token = ++state.token;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en";
  const v = pickVoice("en");
  if (v) u.voice = v;
  u.rate = state.rate;
  u.onend = u.onerror = () => token === state.token && then();
  synth.speak(u);
}

function startParagraph(i) {
  const item = state.item;
  while (i < item.paragraphs.length && !paraText(item, i).trim()) i++;
  if (i >= item.paragraphs.length) return finishItem();
  state.para = i;
  state.sentences = splitSentences(paraText(item, i));
  state.sent = 0;
  render();
  scheduleSave(false);
  speakSentence();
}

function speakSentence() {
  if (!synth) return;
  const token = ++state.token;
  synth.cancel();
  const text = state.sentences[state.sent];
  if (text == null) return startParagraph(state.para + 1);
  const u = new SpeechSynthesisUtterance(text);
  const lang = speechLang(state.item);
  u.lang = lang;
  const v = pickVoice(lang);
  if (v) u.voice = v;
  u.rate = state.rate;
  u.onend = () => {
    if (token !== state.token || !state.playing) return;
    state.errors = 0;
    state.sent++;
    if (state.sent < state.sentences.length) speakSentence();
    else startParagraph(state.para + 1);
  };
  u.onerror = (e) => {
    if (token !== state.token) return;
    if (e.error === "interrupted" || e.error === "canceled") return;
    console.warn("speech error", e.error);
    if (++state.errors >= 3) {
      state.errors = 0;
      state.playing = false;
      render();
      document.dispatchEvent(new CustomEvent("rh:ttserror", { detail: { error: e.error } }));
      return;
    }
    state.sent++;
    speakSentence();
  };
  synth.speak(u);
}

function restartSentence() {
  speakSentence();
}

function finishItem() {
  scheduleSave(true, true);
  next();
}

async function next() {
  const id = state.queue.shift();
  if (id) return load(id, undefined, { announce: true });
  state.playing = false;
  render();
  releaseWakeLock();
}

function jump(i) {
  if (!state.item) return;
  if (i >= state.item.paragraphs.length) return finishItem();
  state.playing = true;
  startParagraph(i);
}

export function playFrom(id, paragraph) {
  if (state.item?.id === id) return jump(paragraph);
  return playItem(id, paragraph);
}

function toggle() {
  if (!state.item) return;
  if (state.playing) {
    state.playing = false;
    state.token++;
    synth.cancel();
    scheduleSave(false, true);
    releaseWakeLock();
  } else {
    state.playing = true;
    requestWakeLock();
    speakSentence();
  }
  render();
}

function stop() {
  state.playing = false;
  state.token++;
  synth?.cancel();
  if (state.item) scheduleSave(false, true);
  state.item = null;
  state.queue = [];
  $("player").hidden = true;
  releaseWakeLock();
  document.dispatchEvent(new CustomEvent("rh:now", { detail: { itemId: null } }));
}

function scheduleSave(finished, immediate = false) {
  const item = state.item;
  if (!item) return;
  const para = state.para;
  clearTimeout(state.saveTimer);
  const go = () => api.saveProgress(item.id, para, finished);
  if (immediate || finished) go();
  else state.saveTimer = setTimeout(go, 1500);
}

function render() {
  const item = state.item;
  if (!item) return;
  $("playerTitle").textContent = title(item);
  const total = item.paragraphs.length;
  const left = state.queue.length;
  $("playerSub").textContent =
    `¶ ${state.para + 1} of ${total}` +
    (item.citation.outlet ? ` · ${item.citation.outlet}` : "") +
    (left ? ` · ${left} more in thread` : "") +
    (state.original ? " · original language" : "");
  $("playerProgress").style.width = `${Math.round(((state.para + 1) / total) * 100)}%`;
  $("pPlay").textContent = state.playing ? "⏸" : "▶";
  document.dispatchEvent(new CustomEvent("rh:now", { detail: { itemId: item.id, paragraph: state.para } }));
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => (state.wakeLock = null));
    }
  } catch {
    // not available or denied; fine
  }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}
