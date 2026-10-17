// MangaDex helper: retries, rate-limit spacing, caching, full pagination, volume/season detection.
const BASE = "https://api.mangadex.org", cache = new Map(), pending = new Map();
let last = Promise.resolve();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const throttle = () => (last = last.then(() => sleep(220))); // stay under MangaDex's ~5 req/s limit

async function mdGet(path, ttl = 300000) {
  const hit = cache.get(path);
  if (hit && hit.exp > Date.now()) return hit.data;
  if (pending.has(path)) return pending.get(path);
  const p = (async () => {
    let err;
    for (let i = 0; i < 4; i++) {
      await throttle();
      try {
        const r = await fetch(BASE + path, { headers: { "User-Agent": "tonedot/2.0", Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
        if (r.status === 429 || r.status >= 500) { err = new Error("MangaDex " + r.status); await sleep(+r.headers.get("retry-after") * 1000 || 700 * 2 ** i); continue; }
        const data = await r.json();
        if (!r.ok) throw Object.assign(new Error("MangaDex " + r.status), { final: true });
        if (cache.size > 300) cache.delete(cache.keys().next().value);
        cache.set(path, { data, exp: Date.now() + ttl });
        return data;
      } catch (e) { if (e.final) throw e; err = e; await sleep(500 * 2 ** i); }
    }
    throw err || new Error("MangaDex unreachable");
  })();
  pending.set(path, p);
  try { return await p; } finally { pending.delete(path); }
}

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const num = v => (v == null || v === "" || isNaN(v) ? null : parseFloat(v));

async function findManga(al, titles) {
  let fallback = null;
  for (const t of titles) {
    const r = await mdGet("/manga?limit=10&title=" + encodeURIComponent(t) + "&availableTranslatedLanguage[]=en&order[relevance]=desc");
    const list = r.data || [];
    const byId = list.find(m => al && m.attributes.links && m.attributes.links.al === String(al));
    if (byId) return { manga: byId, matched: "exact" };
    const byName = list.find(m => [m.attributes.title, ...(m.attributes.altTitles || [])].some(o => Object.values(o).some(x => norm(x) === norm(t))));
    if (byName) return { manga: byName, matched: "title" };
    fallback = fallback || list[0];
  }
  return fallback ? { manga: fallback, matched: "guess" } : null;
}

async function allChapters(id) {
  const out = [];
  for (let offset = 0, total = 1; offset < total && offset < 10000; offset += 500) {
    const r = await mdGet(`/manga/${id}/feed?limit=500&offset=${offset}&translatedLanguage[]=en&order[volume]=asc&order[chapter]=asc&includes[]=scanlation_group&includeExternalUrl=0&includeEmptyPages=0&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`);
    total = r.total || 0;
    out.push(...r.data);
  }
  const best = new Map();
  for (const c of out) {
    const a = c.attributes;
    if (a.externalUrl || !a.pages) continue;
    const key = a.chapter == null ? c.id : (a.volume || "") + "|" + a.chapter; // volume is part of the key, so restarted numbering isn't dropped
    const old = best.get(key);
    if (!old || a.pages > old.attributes.pages) best.set(key, c);
  }
  const rows = [...best.values()].map(c => ({
    id: c.id, ch: c.attributes.chapter, vol: c.attributes.volume, title: c.attributes.title, pages: c.attributes.pages,
    group: c.relationships.filter(x => x.type === "scanlation_group" && x.attributes).map(x => x.attributes.name).join(", ")
  }));
  const vn = v => (num(v.vol) == null ? 1e9 : num(v.vol));
  rows.sort((a, b) => vn(a) - vn(b) || (num(a.ch) ?? 1e9) - (num(b.ch) ?? 1e9));
  let season = 1, max = 0, seasons = false; // a drop back to chapter ~1 in a later volume means a new season
  rows.forEach(c => {
    const n = num(c.ch);
    if (n != null && c.vol && n <= 1.5 && max >= 10 && rows.some(x => x.vol && x.vol !== c.vol)) { season++; max = 0; seasons = true; }
    if (n != null) max = Math.max(max, n);
    c.s = season;
  });
  return { rows, seasons };
}

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...extra } });

export async function handleMangadex(url) {
  const q = Object.fromEntries(url.searchParams);
  try {
    if (q.action === "chapters") {
      const titles = [q.title, q.alt].filter(Boolean);
      if (!titles.length) return json({ error: "title required" }, 400);
      const f = await findManga(q.al, titles);
      if (!f) return json({ error: "No English chapters found on MangaDex" }, 404);
      const { rows, seasons } = await allChapters(f.manga.id);
      const t = f.manga.attributes.title;
      return json({ mdId: f.manga.id, mdTitle: t.en || Object.values(t)[0], matched: f.matched, seasons, chapters: rows }, 200, { "Cache-Control": "public, max-age=300" });
    }
    if (q.action === "pages") {
      if (!/^[0-9a-f-]{36}$/.test(String(q.id))) return json({ error: "bad id" }, 400);
      const s = await mdGet("/at-home/server/" + q.id, 60000);
      return json({ base: s.baseUrl, hash: s.chapter.hash, data: s.chapter.data, saver: s.chapter.dataSaver });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e.message || "Could not reach MangaDex" }, 502);
  }
}

// Proxies chapter images from MangaDex hosts only (not an open proxy). Streams the body and retries failures.
export async function handleImage(url) {
  let u;
  try { u = new URL(String(url.searchParams.get("u"))); } catch { return new Response(null, { status: 400 }); }
  if (u.protocol !== "https:" || !(u.hostname.endsWith(".mangadex.network") || u.hostname.endsWith(".mangadex.org"))) return new Response(null, { status: 400 });
  let status = 502;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": "tonedot/2.0" } });
      if (r.ok) return new Response(r.body, { headers: { "Content-Type": r.headers.get("content-type") || "image/jpeg", "Cache-Control": "public, max-age=604800, immutable" } });
      status = r.status;
      if (r.status < 500 && r.status !== 429) break;
    } catch { status = 502; }
    await sleep(400 * 2 ** i);
  }
  return new Response(null, { status });
}

// Cloudflare Pages "advanced mode" entry. Works with drag-and-drop upload, Git, or Wrangler. Adds edge caching.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const h = url.pathname === "/api/mangadex" ? handleMangadex : url.pathname === "/api/image" ? handleImage : null;
    if (!h) return env.ASSETS.fetch(request);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const cacheable = url.pathname === "/api/image" || url.searchParams.get("action") === "chapters";
    if (cacheable) { const hit = await caches.default.match(request); if (hit) return hit; }
    const res = await h(url);
    if (cacheable && res.ok) ctx.waitUntil(caches.default.put(request, res.clone()));
    return res;
  }
};
