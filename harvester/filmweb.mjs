// Listy „Chcę zobaczyć” z publicznych profili Filmwebu → site/listy.json (strona dopasowuje je do katalogu).
// Uruchom: FILMWEB_USERS="nick:Imię,nick2:Imię2" node filmweb.mjs [filmweb-cache.json] > listy.json   (Node 18+)
// Filmweb nie ma oficjalnego API; to wewnętrzne endpointy strony, dostępne bez logowania dla publicznych profili.
// Cache trzyma tytuły i lata, więc przy kolejnych przebiegach pytamy tylko o nowo dodane pozycje.

import { readFileSync, writeFileSync, existsSync, renameSync, appendFileSync } from 'node:fs';

const BASE = process.env.FILMWEB_HOST || 'https://www.filmweb.pl';
const USERS = (process.env.FILMWEB_USERS || '').split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const [nick, label] = s.split(':'); return { nick: nick.trim(), label: (label || nick).trim() }; });
const KINDS = [['film', 'film'], ['serial', 'serial']];   // [endpoint, rodzaj w wyniku]
const INFO_GAP_MS = Number(process.env.FILMWEB_GAP_MS || 400);
const REQ_TIMEOUT_MS = 30000;
const repo = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : 'local test';
const HEADERS = { 'User-Agent': `PolkaRaczynskich/1.0 ( ${repo} )`, Accept: 'application/json', 'x-locale': 'pl_PL' };

const cachePath = process.argv[2];
// poprzednio opublikowane listy: gdy Filmweb nie odpowie dla kogoś, zostawiamy jego starą listę
const prevPath = process.env.PREV;
const prev = new Map((prevPath && existsSync(prevPath) ? (() => { try { return JSON.parse(readFileSync(prevPath, 'utf8')).users || []; } catch { return []; } })() : []).map((u) => [u.nick, u]));
const cache = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s);

async function getJson(path, tries = 0) {
  try {
    const res = await fetch(BASE + path, { headers: HEADERS, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
    if ((res.status === 429 || res.status >= 500) && tries < 3) { await sleep(2000 * (tries + 1)); return getJson(path, tries + 1); }
    if (!res.ok) { const e = new Error(`Filmweb HTTP ${res.status} ${path}`); e.status = res.status; throw e; }
    return res.json();
  } catch (e) {
    if (e.status || tries >= 3) throw e;
    await sleep(2000 * (tries + 1));
    return getJson(path, tries + 1);
  }
}

let asked = 0, failures = 0;
async function info(id) {
  if (cache[id]) return cache[id];
  await sleep(INFO_GAP_MS);
  const d = await getJson(`/api/v1/title/${id}/info`);
  asked++;
  const t = d.title || d.originalTitle || '';
  if (!t) return null;
  return cache[id] = { t, o: d.originalTitle && d.originalTitle !== t ? d.originalTitle : undefined, y: Number(d.year) || 0 };
}

const out = { updatedAt: new Date().toISOString(), users: [] };
const summary = [];
for (const u of USERS) {
  const lists = { want: [] };
  let ok = true;
  for (const [ep, kind] of KINDS) {
    let entries;
    try { entries = await getJson(`/api/v1/user/${encodeURIComponent(u.nick)}/want2see/${ep}`); }
    catch (e) { ok = false; log(`${u.nick} (${ep}): ${e.message}\n`); continue; }
    for (const x of Array.isArray(entries) ? entries : []) {
      const id = x.entity ?? x.id;
      if (!id) continue;
      try {
        const it = await info(id);
        if (it) lists.want.push({ id, k: kind, ...it, at: x.timestamp || undefined });
      } catch (e) { failures++; log(`${u.nick}: tytuł ${id}: ${e.message}\n`); }
    }
  }
  // nie publikujemy pustej listy, gdy Filmweb nie odpowiedział: strona zostanie przy poprzedniej
  if (!ok && !lists.want.length) {
    const old = prev.get(u.nick);
    if (old) out.users.push({ ...old, label: u.label, stale: true });
    summary.push(`${u.label} (${u.nick}): Filmweb nie odpowiedział${old ? ', zostaje poprzednia lista' : ''}`);
    continue;
  }
  lists.want.sort((a, b) => (b.at || 0) - (a.at || 0));
  out.users.push({ nick: u.nick, label: u.label, lists });
  summary.push(`${u.label} (${u.nick}): do obejrzenia ${lists.want.length}`);
}

log(`Filmweb: ${summary.join(' · ') || 'brak użytkowników'}; nowe tytuły ${asked}, błędy ${failures}\n`);
if (cachePath && asked) { writeFileSync(cachePath + '.tmp', JSON.stringify(cache)); renameSync(cachePath + '.tmp', cachePath); }
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  ['### Listy z Filmwebu', '', ...summary.map((s) => '- ' + s), '', ''].join('\n'));
if (!out.users.length) { log('Żadna lista nie została pobrana.\n'); process.exit(1); }
process.stdout.write(JSON.stringify(out));
