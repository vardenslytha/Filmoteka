// Okładki płyt z MusicBrainz i Cover Art Archive (darmowe, bez klucza).
// Uruchom: node enrich-music.mjs music.json [mb-cache.json] > music-enriched.json   (Node 18+)
// MusicBrainz pozwala na 1 zapytanie na sekundę, więc pierwsze uzupełnienie ~18 tys. płyt trwa kilka godzin.
// Dlatego skrypt pracuje porcjami: MB_MINUTES ogranicza czas, cache trzyma wyniki między uruchomieniami,
// a płyty bez wpisu w cache po prostu czekają na kolejny przebieg.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

// *_HOST tylko do testów
const MB = process.env.MB_HOST || 'https://musicbrainz.org';
const CAA = process.env.CAA_HOST || 'https://coverartarchive.org';
const CAA_PUBLIC = 'https://coverartarchive.org';
const repo = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : 'local test';
const UA = `PolkaRaczynskich/1.0 ( ${repo} )`;   // MusicBrainz wymaga opisowego User-Agenta
const MATCH_VERSION = 1;
const MB_GAP_MS = Number(process.env.MB_GAP_MS || 1100);     // odstęp między zapytaniami do MusicBrainz
const MINUTES = Number(process.env.MB_MINUTES || 15);
const RETRY_MISSES_AFTER_DAYS = 60;

const dataPath = process.argv[2] || 'music.json';
const cachePath = process.argv[3];
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const rawCache = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const cache = Object.fromEntries(Object.entries(rawCache).filter(([, c]) => c.v === MATCH_VERSION));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s);
const started = Date.now();
const outOfTime = () => Date.now() - started > MINUTES * 60000;

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
  .replace(/&/g, ' and ').replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const surname = (n) => norm(n).split(' ').pop();
// tytuł bez dopisków w nawiasach i podtytułów po dwukropku, do zapytania i porównania
const baseTitle = (t) => (t || '').replace(/\s*[\[(].*?[\])]\s*/g, ' ').split(/\s*[:;]\s+/)[0].trim();
const phrase = (s) => '"' + s.replace(/[\\"]/g, '\\$&') + '"';

// Zerwane połączenie (np. „fetch failed”) ponawiamy kilka razy, zanim uznamy płytę za błąd.
async function get(url, opts, tries = 0) {
  try { return await fetch(url, opts); }
  catch (e) {
    if (tries >= 3) { const err = new Error(`${e.message}${e.cause?.code ? ' (' + e.cause.code + ')' : ''} – ${new URL(url).host}`); throw err; }
    await sleep(2000 * (tries + 1));
    return get(url, opts, tries + 1);
  }
}

let lastMb = 0;
async function mb(path, tries = 0) {
  const wait = lastMb + MB_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastMb = Date.now();
  const res = await get(`${MB}${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if ((res.status === 503 || res.status === 429) && tries < 4) { await sleep(3000 * (tries + 1)); return mb(path, tries + 1); }
  if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
  return res.json();
}

// Czy Cover Art Archive ma okładkę grupy wydań? Istniejąca okładka odpowiada przekierowaniem do archive.org.
async function hasCover(rg) {
  const res = await get(`${CAA}/release-group/${rg}/front-250`, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': UA } });
  if (res.status >= 300 && res.status < 400) return true;
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`Cover Art Archive HTTP ${res.status}`);
}

async function match(r) {
  const title = baseTitle(r.t);
  const who = r.d || [];
  if (!title || !who.length) return null;      // bez wykonawcy (składanki) łatwo o cudzą okładkę
  const q = `releasegroup:${phrase(title)} AND artist:${phrase(who[0])}`;
  const { 'release-groups': groups = [] } = await mb(`/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=8`);
  const tk = norm(title), discYear = Number(r.y) || 0;
  const people = who.flatMap((n) => [norm(n), n.trim().includes(' ') ? surname(n) : null]).filter(Boolean);
  const cands = groups.filter((g) => {
    const gt = norm(baseTitle(g.title));
    const titleOk = gt === tk || gt.startsWith(tk + ' ') || tk.startsWith(gt + ' ');
    const credits = (g['artist-credit'] || []).flatMap((c) => [c.name, c.artist?.name, c.artist?.['sort-name']?.split(',')[0]]).filter(Boolean);
    const whoOk = credits.some((c) => { const n = norm(c); return people.includes(n) || people.includes(surname(c)); });
    const y = Number((g['first-release-date'] || '').slice(0, 4));
    const yearOk = !discYear || !y || y <= discYear + 1;
    return titleOk && whoOk && yearOk && (g.score ?? 100) >= 70;
  }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a['primary-type'] === 'Album' ? -1 : 0) - (b['primary-type'] === 'Album' ? -1 : 0));
  if (!cands.length) return null;
  // pierwsza pasująca grupa z okładką; jeśli żadna nie ma okładki, zapamiętujemy samo dopasowanie
  for (const g of cands.slice(0, 2)) if (await hasCover(g.id)) return { rg: g.id, cover: `${CAA_PUBLIC}/release-group/${g.id}/front-250`, date: g['first-release-date'] || '' };
  return { rg: cands[0].id, cover: null, date: cands[0]['first-release-date'] || '' };
}

const now = Date.now();
const before = new Map(data.recs.map((r) => [r.id, (r.cv || '') + '|' + (r.p || '')]));
const apply = (r, c) => {
  if (c && !c.miss) { r.mb = c.rg; if (c.cover) r.cv = c.cover; else delete r.cv; if (c.date) r.p = c.date; }
};
// Dopasowania sprzed v10 nie mają daty pierwszego wydania: dociągamy ją jednym zapytaniem o grupę wydań.
const needsDate = (c) => c && !c.miss && c.date === undefined;
for (const r of data.recs) apply(r, cache[r.id]);

const todo = data.recs.filter((r) => {
  const c = cache[r.id];
  if (needsDate(c)) return true;
  if (!(r.d || []).length) return false;
  return !c || (c.miss && now - c.at > RETRY_MISSES_AFTER_DAYS * 864e5);
}).sort((a, b) => b.h.length - a.h.length || Number(b.y || 0) - Number(a.y || 0)); // najpierw płyty z największą liczbą egzemplarzy

let asked = 0, hits = 0, covers = 0, failures = 0, dated = 0;
for (const r of todo) {
  if (outOfTime()) break;
  try {
    if (needsDate(cache[r.id])) {
      const g = await mb(`/ws/2/release-group/${encodeURIComponent(cache[r.id].rg)}?fmt=json`);
      cache[r.id].date = g['first-release-date'] || '';
      dated++; apply(r, cache[r.id]);
      continue;
    }
    const m = await match(r);
    asked++;
    const c = m ? { v: MATCH_VERSION, at: now, rg: m.rg, cover: m.cover, date: m.date } : { v: MATCH_VERSION, at: now, miss: true };
    cache[r.id] = c;
    if (m) { hits++; if (m.cover) covers++; }
    apply(r, c);
  } catch (e) {
    failures++;
    log(`${r.t}: ${e.message}\n`);
    if (failures > 30) { log('Za dużo błędów MusicBrainz, kończę tę porcję.\n'); break; }
  }
  if (asked % 200 === 0 && asked) log(`[${((Date.now() - started) / 60000).toFixed(1)} min] sprawdzone ${asked}/${todo.length} · dopasowane ${hits} · z okładką ${covers}\n`);
}

const withCover = data.recs.filter((r) => r.cv).length;
const changed = data.recs.filter((r) => (r.cv || '') + '|' + (r.p || '') !== before.get(r.id)).length;
const left = todo.length - asked - dated;
log(`Gotowe: sprawdzone teraz ${asked}, dopasowane ${hits}, z okładką ${covers}; okładki ma ${withCover}/${data.recs.length} płyt; zostało do sprawdzenia ${left}\n`);
if (cachePath) writeFileSync(cachePath, JSON.stringify(cache));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed > 0}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
  '### Muzyka: okładki z MusicBrainz', '', '| | |', '|---|---|',
  `| Sprawdzone w tym przebiegu | ${asked} |`, `| Dopasowane / z okładką | ${hits} / ${covers} |`,
  `| Płyty z okładką na stronie | ${withCover} z ${data.recs.length} |`, `| Zostało do sprawdzenia | ${left} |`,
  `| Dociągnięte daty pierwszego wydania | ${dated} |`, `| Błędy zapytań | ${failures} |`, '', ''].join('\n'));
process.stdout.write(JSON.stringify(data));
