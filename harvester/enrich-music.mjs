// Okładki płyt z MusicBrainz i Cover Art Archive (darmowe, bez klucza).
// Uruchom: node enrich-music.mjs music.json [mb-cache.json] > music-enriched.json   (Node 18+)
// MusicBrainz pozwala na 1 zapytanie na sekundę, więc pierwsze uzupełnienie ~18 tys. płyt trwa kilka godzin.
// Dlatego skrypt pracuje porcjami: MB_MINUTES ogranicza czas, cache trzyma wyniki między uruchomieniami,
// a płyty bez wpisu w cache po prostu czekają na kolejny przebieg.

import { readFileSync, writeFileSync, existsSync, appendFileSync, renameSync } from 'node:fs';

// *_HOST tylko do testów
const MB = process.env.MB_HOST || 'https://musicbrainz.org';
const CAA = process.env.CAA_HOST || 'https://coverartarchive.org';
const CAA_PUBLIC = 'https://coverartarchive.org';
const repo = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : 'local test';
const UA = `PolkaRaczynskich/1.0 ( ${repo} )`;   // MusicBrainz wymaga opisowego User-Agenta
const MATCH_VERSION = 1;
// Wersja reguł szukania. Płyty, które nie dopasowały się starszymi regułami, sprawdzamy ponownie od razu
// (dopasowane zostają w cache). 2 = czyszczenie tytułów z doklejonych wykonawców i ról.
const MATCHER = 2;
const MB_GAP_MS = Number(process.env.MB_GAP_MS || 1100);     // odstęp między zapytaniami do MusicBrainz
const MINUTES = Number(process.env.MB_MINUTES || 15);
const RETRY_MISSES_AFTER_DAYS = 60;
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 30000); // zawieszone połączenie przerywamy po 30 s
const SAVE_EVERY = 100;                                            // co tyle zapytań zapisujemy cache na dysk

const dataPath = process.argv[2] || 'music.json';
const cachePath = process.argv[3];
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const rawCache = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const cache = Object.fromEntries(Object.entries(rawCache).filter(([, c]) => c.v === MATCH_VERSION));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s);
const started = Date.now();
const outOfTime = () => Date.now() - started > MINUTES * 60000;

// Cache zapisujemy co SAVE_EVERY zapytań i przy przerwaniu (anulowanie, limit czasu joba),
// żeby przerwany przebieg nie tracił całej porcji. Zapis przez plik tymczasowy, więc nigdy nie zostaje połówka.
let dirty = 0;
function saveCache(why = '') {
  if (!cachePath || !dirty) return;
  writeFileSync(cachePath + '.tmp', JSON.stringify(cache));
  renameSync(cachePath + '.tmp', cachePath);
  dirty = 0;
  if (why) log(`Zapisano cache (${why}).\n`);
}
const touch = () => { if (++dirty >= SAVE_EVERY) saveCache(); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveCache(`przerwanie ${sig}`); process.exit(130); });

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
  .replace(/&/g, ' and ').replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const surname = (n) => norm(n).split(' ').pop();
// tytuł bez dopisków w nawiasach i podtytułów po dwukropku, do zapytania i porównania
const baseTitle = (t) => (t || '').replace(/\s*[\[(].*?[\])]\s*/g, ' ').split(/\s*[:;]\s+/)[0].trim();
// Katalog dokleja do tytułu albumu wykonawców i role: "Kind of blue Miles Davis [wyk.]",
// "Officium novum Jan Garbarek, The Hilliard Ensamble", "WASZA WSPANIAŁOŚĆ wyk., muz. i sł". Odcinamy to.
const ROLE_CUT = /\s+(?:wyk\.|wyk\b|muz\.|sł\.|sł\b|słowa\b|tekst\b|wykonanie\b|dyr\.|dyryguje\b|aranż|oprac\.|feat\.|ft\.)(?:.*)$/i;
function albumTitle(t, who) {
  let s = baseTitle((t || '').replace(/\s*\[[^\]]*\]\s*/g, ' ')).replace(ROLE_CUT, '').trim();
  const low = s.toLowerCase();
  let cutAt = -1;
  for (const n of who || []) {
    for (const v of [n, n.replace(/^The\s+/i, '')]) {
      const i = v.length > 2 ? low.indexOf(' ' + v.toLowerCase()) : -1;
      if (i > 0 && (cutAt < 0 || i < cutAt)) cutAt = i;   // nazwisko w środku albo na końcu tytułu
    }
  }
  if (cutAt > 0) s = s.slice(0, cutAt);
  return s.replace(/[\s.,:;\/-]+$/, '').trim();
}
const phrase = (s) => '"' + s.replace(/[\\"]/g, '\\$&') + '"';

// Zerwane połączenie (np. „fetch failed”) ponawiamy kilka razy, zanim uznamy płytę za błąd.
// Każde zapytanie ma limit czasu, inaczej jedno zawieszone połączenie potrafi czekać kilka minut.
async function get(url, opts = {}, tries = 0) {
  try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }); }
  catch (e) {
    if (tries >= 3) { const err = new Error(`${e.message}${e.cause?.code ? ' (' + e.cause.code + ')' : ''} – ${new URL(url).host}`); throw err; }
    await sleep(2000 * (tries + 1));
    return get(url, opts, tries + 1);
  }
}

const misses = {}, missSamples = [];
// "Album", "Album+Live", "Album+Compilation", "EP"… – typ główny i dodatkowe z MusicBrainz
const typesOf = (g) => [g['primary-type'] || '', ...(g['secondary-types'] || [])].filter(Boolean).join('+');
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
  const title = albumTitle(r.t, r.d);
  const who = r.d || [];
  if (!title || !who.length) return null;      // bez wykonawcy (składanki) łatwo o cudzą okładkę
  const q = `releasegroup:${phrase(title)} AND artist:${phrase(who[0])}`;
  const { 'release-groups': groups = [] } = await mb(`/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=8`);
  const tk = norm(title), discYear = Number(r.y) || 0;
  const people = who.flatMap((n) => [norm(n), n.trim().includes(' ') ? surname(n) : null]).filter(Boolean);
  // przy braku dopasowania zapamiętujemy, który warunek odpadł – do diagnozy w podsumowaniu
  const why = { title: 0, who: 0, year: 0, score: 0 };
  const cands = groups.filter((g) => {
    const gt = norm(baseTitle(g.title));
    const titleOk = gt === tk || gt.startsWith(tk + ' ') || tk.startsWith(gt + ' ');
    const credits = (g['artist-credit'] || []).flatMap((c) => [c.name, c.artist?.name, c.artist?.['sort-name']?.split(',')[0]]).filter(Boolean);
    const whoOk = credits.some((c) => { const n = norm(c); return people.includes(n) || people.includes(surname(c)); });
    const y = Number((g['first-release-date'] || '').slice(0, 4));
    const yearOk = !discYear || !y || y <= discYear + 1;
    const scoreOk = (g.score ?? 100) >= 70;
    if (!titleOk) why.title++; else if (!whoOk) why.who++; else if (!yearOk) why.year++; else if (!scoreOk) why.score++;
    return titleOk && whoOk && yearOk && scoreOk;
  }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a['primary-type'] === 'Album' ? -1 : 0) - (b['primary-type'] === 'Album' ? -1 : 0));
  if (!cands.length) {
    const reason = !groups.length ? 'brak wyników' : why.title === groups.length ? 'tytuł' : why.who ? 'wykonawca' : why.year ? 'rok' : 'trafność';
    misses[reason] = (misses[reason] || 0) + 1;
    if (missSamples.length < 15) {
      const g = groups[0];
      missSamples.push(`${r.t} / ${who[0]} (${r.y || '?'}) → ${reason}${g ? `; MB: ${g.title} / ${(g['artist-credit'] || []).map((c) => c.name).join(', ')} (${(g['first-release-date'] || '?').slice(0, 4)}, ${g.score})` : ''}`);
    }
    return null;
  }
  return cands;
}

// Pierwsza pasująca grupa z okładką; jeśli żadna nie ma okładki, zapamiętujemy samo dopasowanie.
// Cover Art Archive nie ma limitu MusicBrainz, więc sprawdzamy okładki równolegle z kolejnymi zapytaniami do MusicBrainz.
const meta = (g) => ({ date: g['first-release-date'] || '', types: typesOf(g), title: g.title || '' });
async function pickCover(cands) {
  for (const g of cands.slice(0, 2)) if (await hasCover(g.id)) return { rg: g.id, cover: `${CAA_PUBLIC}/release-group/${g.id}/front-250`, ...meta(g) };
  return { rg: cands[0].id, cover: null, ...meta(cands[0]) };
}

const now = Date.now();
const apply = (r, c) => {
  if (c && !c.miss) {
    r.mb = c.rg; if (c.cover) r.cv = c.cover; else delete r.cv; if (c.date) r.p = c.date;
    if (c.title) r.t = c.title;                           // czysty tytuł albumu zamiast katalogowego z doklejkami
    if (c.types) r.tp = c.types;                          // np. "Album", "Album+Live", "Album+Compilation"
    if (c.pop && c.pop.u != null) r.pu = c.pop.u;          // słuchacze w ListenBrainz
  }
};
// Dopasowania sprzed v10 nie mają daty pierwszego wydania: dociągamy ją jednym zapytaniem o grupę wydań.
const needsDate = (c) => c && !c.miss && (c.date === undefined || c.types === undefined || c.title === undefined);
for (const r of data.recs) apply(r, cache[r.id]);
// stan po nałożeniu cache; „zmiana” to tylko to, co przybyło z nowych zapytań
const before = new Map(data.recs.map((r) => [r.id, [r.cv, r.p, r.tp, r.pu].join('|')]));

const todo = data.recs.filter((r) => {
  const c = cache[r.id];
  if (needsDate(c)) return true;
  if (!(r.d || []).length) return false;
  return !c || (c.miss && ((c.mv || 1) < MATCHER || now - c.at > RETRY_MISSES_AFTER_DAYS * 864e5));
}).sort((a, b) => b.h.length - a.h.length || Number(b.y || 0) - Number(a.y || 0)); // najpierw płyty z największą liczbą egzemplarzy

let asked = 0, hits = 0, covers = 0, failures = 0, dated = 0;
const COVER_PARALLEL = 4;          // ile sprawdzeń okładek naraz czeka w tle
const pending = new Set();
const fail = (r, e) => { failures++; log(`${r.t}: ${e.message}\n`); };
function save(r, m) {
  asked++;
  const c = m ? { v: MATCH_VERSION, mv: MATCHER, at: now, rg: m.rg, cover: m.cover, date: m.date, types: m.types, title: m.title }
    : { v: MATCH_VERSION, mv: MATCHER, at: now, miss: true };
  cache[r.id] = c; touch();
  if (m) { hits++; if (m.cover) covers++; }
  apply(r, c);
  if (asked % 200 === 0) log(`[${((Date.now() - started) / 60000).toFixed(1)} min] sprawdzone ${asked}/${todo.length} · dopasowane ${hits} · z okładką ${covers}\n`);
}
for (const r of todo) {
  if (outOfTime()) break;
  if (failures > 30) { log('Za dużo błędów MusicBrainz, kończę tę porcję.\n'); break; }
  try {
    if (needsDate(cache[r.id])) {
      const g = await mb(`/ws/2/release-group/${encodeURIComponent(cache[r.id].rg)}?fmt=json`);
      cache[r.id].date = g['first-release-date'] || '';
      cache[r.id].types = typesOf(g);
      cache[r.id].title = g.title || '';
      dated++; touch(); apply(r, cache[r.id]);
      continue;
    }
    const cands = await match(r);
    if (!cands) { save(r, null); continue; }
    while (pending.size >= COVER_PARALLEL) await Promise.race(pending);
    const p = pickCover(cands).then((m) => save(r, m), (e) => fail(r, e)).finally(() => pending.delete(p));
    pending.add(p);
  } catch (e) { fail(r, e); }
}
await Promise.all(pending);

saveCache();

// ---------- popularność z ListenBrainz ----------
// Liczba słuchaczy grupy wydań (otwarte dane MetaBrainz, bez klucza, po 50 identyfikatorów na zapytanie).
// Odświeżamy raz na POP_REFRESH_DAYS dni.
const LB = process.env.LB_HOST || 'https://api.listenbrainz.org';
const LB_MINUTES = Number(process.env.LB_MINUTES ?? 8);
const POP_REFRESH_DAYS = 30;
let popAsked = 0, popFailures = 0;
{
  const popStarted = Date.now();
  const due = new Map();   // rg → wpisy cache do uzupełnienia
  for (const c of Object.values(cache)) {
    if (!c || c.miss || !c.rg) continue;
    if (c.pop && now - c.pop.at < POP_REFRESH_DAYS * 864e5) continue;
    if (!due.has(c.rg)) due.set(c.rg, []);
    due.get(c.rg).push(c);
  }
  const ids = [...due.keys()];
  for (let i = 0; i < ids.length && LB_MINUTES > 0; i += 50) {
    if (Date.now() - popStarted > LB_MINUTES * 60000) break;
    const batch = ids.slice(i, i + 50);
    try {
      const res = await get(`${LB}/1/popularity/release-group`, { method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json' }, body: JSON.stringify({ release_group_mbids: batch }) });
      if (res.status === 429) { await sleep(10000); i -= 50; continue; }
      if (!res.ok) throw new Error(`ListenBrainz HTTP ${res.status}`);
      const rows = await res.json();
      for (const row of Array.isArray(rows) ? rows : []) {
        for (const c of due.get(row.release_group_mbid) || []) c.pop = { at: now, u: row.total_user_count ?? 0, l: row.total_listen_count ?? 0 };
      }
      popAsked += batch.length; dirty++;
    } catch (e) {
      popFailures++; log(`ListenBrainz: ${e.message}\n`);
      if (popFailures > 5) break;
    }
    await sleep(1000);
  }
  if (popAsked) for (const r of data.recs) apply(r, cache[r.id]);
}

const withCover = data.recs.filter((r) => r.cv).length;
const changed = data.recs.filter((r) => [r.cv, r.p, r.tp, r.pu].join('|') !== before.get(r.id)).length;
const left = todo.length - asked - dated;
log(`Gotowe: sprawdzone teraz ${asked}, dopasowane ${hits}, z okładką ${covers}; okładki ma ${withCover}/${data.recs.length} płyt; zostało do sprawdzenia ${left}\n`);
// to samo co w podsumowaniu, także w logu (logi da się czytać przez API, podsumowania nie)
log(`Bez dopasowania: ${Object.entries(misses).map(([k, v]) => `${k} ${v}`).join(', ') || '–'}\n`);
for (const m of missSamples) log(`  bez dopasowania: ${m}\n`);
log(`ListenBrainz: sprawdzone grupy wydań ${popAsked}, błędy ${popFailures}; płyty z popularnością ${data.recs.filter((r) => r.pu > 0).length}\n`);
saveCache();
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed > 0}\nremaining=${left}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
  '### Muzyka: okładki z MusicBrainz', '', '| | |', '|---|---|',
  `| Sprawdzone w tym przebiegu | ${asked} |`, `| Dopasowane / z okładką | ${hits} / ${covers} |`,
  `| Płyty z okładką na stronie | ${withCover} z ${data.recs.length} |`, `| Zostało do sprawdzenia | ${left} |`,
  `| Dociągnięte daty i typy wydań | ${dated} |`, `| Popularność z ListenBrainz (sprawdzone grupy wydań) | ${popAsked}${popFailures ? `, błędy: ${popFailures}` : ''} |`,
  `| Płyty z popularnością | ${data.recs.filter((r) => r.pu > 0).length} |`, `| Błędy zapytań | ${failures} |`,
  `| Bez dopasowania (powód) | ${Object.entries(misses).map(([k, v]) => `${k}: ${v}`).join(', ') || '–'} |`, '',
  missSamples.length ? '**Przykłady bez dopasowania:**\n\n' + missSamples.map((m) => '- ' + m).join('\n') : '', '', ''].join('\n'));
process.stdout.write(JSON.stringify(data));
