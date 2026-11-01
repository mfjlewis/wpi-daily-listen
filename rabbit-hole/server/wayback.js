// Ask the Internet Archive's Wayback Machine to save a copy of the page, so
// there is a citable third-party snapshot even if the original disappears.
// Best effort: Save Page Now is slow and rate-limited.

export async function archiveUrl(url) {
  if (!/^https?:\/\//i.test(url || "")) return { status: "skipped", url: "" };
  try {
    const res = await fetch(`https://web.archive.org/save/${url}`, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "RabbitHole/0.1 (personal research archive)" },
      signal: AbortSignal.timeout(120_000),
    });
    const loc = res.headers.get("content-location");
    if (res.ok && loc) return { status: "saved", url: `https://web.archive.org${loc}` };
    if (res.ok && /web\.archive\.org\/web\/\d+/.test(res.url)) return { status: "saved", url: res.url };
  } catch {
    // fall through to the availability check
  }
  // If saving failed (or was throttled), see whether a snapshot already exists.
  try {
    const res = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json();
    const snap = data?.archived_snapshots?.closest;
    if (snap?.available && snap.url) return { status: "existing", url: snap.url.replace(/^http:/, "https:") };
  } catch {
    // ignore
  }
  return { status: "failed", url: "" };
}
