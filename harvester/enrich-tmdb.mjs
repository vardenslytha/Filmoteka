
// Wzbogaca films.json o plakaty, oceny, opisy i poprawne tytuły z TMDB.
// Klucz: zmienna środowiskowa TMDB_API_KEY (sekret w GitHub) albo plik .env obok skryptu.
// Uruchom: node enrich-tmdb.mjs films.json [tmdb-cache.json] > films-enriched.json   (Node 18+)
// Bez klucza przepuszcza dane bez zmian. Klucz nigdy nie trafia do wyniku.
// Cache trzyma dopasowania między uruchomieniami, więc co noc pyta TMDB tylko o nowe filmy.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const envFile = new URL('./.env', import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const KEY = process.env.TMDB_API_KEY;
const dataPath = process.argv[2] || 'films.json';
const cachePath = process.argv[3];
const data = JSON.parse(readFileSync(dataPath, 'utf8'));

if (!KEY) {
  console.error('Brak TMDB_API_KEY – pomijam okładki.');
  process.stdout.write(JSON.stringify(data));
  process.exit(0);
}

// Wersja reguł dopasowania. Zmiana numeru unieważnia stare wpisy w cache (np. błędne plakaty z v1).
const MATCH_VERSION = 2;
const CONCURRENCY = 8;            // TMDB pozwala na ok. 40 zapytań/s
const RETRY_MISSES_AFTER_DAYS = 30;
const IMG = 'https://image.tmdb.org/t/p/w342';

const rawCache = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const cache = Object.fromEntries(Object.entries(rawCache).filter(([, c]) => c.v === MATCH_VERSION));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmdb(path, params = {}, tries = 0) {
  const qs = new URLSearchParams({ api_key: KEY, language: 'pl-PL', ...params });
  const res = await fetch(`https://api.themoviedb.org/3${path}?${qs}`);
  if (res.status === 429 && tries < 5) { await sleep(1500 * (tries + 1)); return tmdb(path, params, tries + 1); }
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status} ${path}`);
  return res.json();
}

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
  .replace(/&/g, ' and ').replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const isSeries = (r) => /Serial/i.test((r.g || []).join()) || /Sezon|odc\./i.test(r.t);
const clean = (s) => (s || '').replace(/\.\s*Sezon.*$/i, '').replace(/[:.]\s*(Kompletny|Kolekcja|kolekcja).*$/i, '')
  .replace(/\s*\(.*?\)\s*/g, ' ').trim();
const yearOf = (x) => Number((x.release_date || x.first_air_date || '').slice(0, 4)) || 0;
// "Tarantino, Quentin" → "tarantino"; "Christopher Nolan" → "nolan"
const surname = (n) => norm(n.includes(',') ? n.split(',')[0] : n.split(/\s+/).pop());

async function directorsOf(kind, id) {
  if (kind === 'tv') {
    const d = await tmdb(`/tv/${id}`);
    return (d.created_by || []).map((p) => p.name);
  }
  const c = await tmdb(`/movie/${id}/credits`);
  return (c.crew || []).filter((p) => p.job === 'Director').map((p) => p.name);
}

async function match(r) {
  const kind = isSeries(r) ? 'tv' : 'movie';
  const discYear = Number(r.y) || 0;
  const queries = [...new Set([clean(r.o), clean(r.t)].filter(Boolean))];
  const keys = queries.map(norm);
  const seen = new Map();
  for (const q of queries) {
    const { results = [] } = await tmdb(`/search/${kind}`, { query: q, include_adult: 'false' });
    for (const x of results) if (!seen.has(x.id)) seen.set(x.id, x);
  }
  const scored = [...seen.values()]
    // premiera nie może być późniejsza niż wydanie płyty (rok tolerancji)
    .filter((x) => !discYear || !yearOf(x) || yearOf(x) <= discYear + 1)
    .map((x) => {
      const titles = [x.title, x.original_title, x.name, x.original_name].map(norm);
      const exact = titles.some((t) => keys.includes(t));
      const prefix = !exact && titles.some((t) => keys.some((k) => t.startsWith(k + ' ') || k.startsWith(t + ' ')));
      const score = (exact ? 100 : prefix ? 25 : 0) + Math.log10((x.vote_count || 0) + 1) * 8 + (x.poster_path ? 3 : 0);
      return { x, exact, prefix, score };
    })
    .filter((s) => s.exact || s.prefix)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;

  // Znany reżyser: bierzemy pierwszego kandydata, którego reżyser się zgadza.
  const who = (r.d || []).map(surname).filter(Boolean);
  if (who.length) {
    for (const s of scored.slice(0, 3)) {
      const dirs = (await directorsOf(kind, s.x.id)).map(surname);
      if (dirs.some((d) => who.includes(d))) return { kind, hit: s.x };
    }
    // reżyser nie pasuje do żadnego: lepiej brak plakatu niż cudzy
    return null;
  }
  // Bez reżysera: tylko dokładny tytuł i film, o którym ktoś w ogóle słyszał
  const top = scored[0];
  return top.exact && (top.x.vote_count || 0) >= 10 ? { kind, hit: top.x } : null;
}

const now = Date.now();
let asked = 0, hits = 0, done = 0;
const todo = data.recs.map((r, i) => i);

async function worker() {
  while (todo.length) {
    const r = data.recs[todo.shift()];
    let c = cache[r.id];
    const stale = c && c.miss && now - c.at > RETRY_MISSES_AFTER_DAYS * 864e5;
    if (!c || stale) {
      try {
        const m = await match(r);
        asked++;
        c = m
          ? { v: MATCH_VERSION, at: now, kind: m.kind, id: m.hit.id,
              title: m.hit.title || m.hit.name || '', orig: m.hit.original_title || m.hit.original_name || '',
              poster: m.hit.poster_path ? IMG + m.hit.poster_path : null,
              rating: m.hit.vote_average ? Math.round(m.hit.vote_average * 10) / 10 : null,
              votes: m.hit.vote_count || 0, overview: (m.hit.overview || '').slice(0, 600) }
          : { v: MATCH_VERSION, at: now, miss: true };
        cache[r.id] = c;
        await sleep(40);
      } catch (e) { process.stderr.write(`\n${r.t}: ${e.message}\n`); c = null; }
    }
    if (c && !c.miss) {
      hits++;
      // Tytuł z katalogu bywa pomieszany; polski tytuł z TMDB jest czystszy.
      if (c.kind === 'movie' && c.title) { r.t = c.title; r.o = c.orig && norm(c.orig) !== norm(c.title) ? c.orig : undefined; }
      r.tmdb = { id: c.id, kind: c.kind, poster: c.poster, rating: c.rating, votes: c.votes, overview: c.overview };
    }
    if (++done % 250 === 0) process.stderr.write(`${done}/${data.recs.length} · z okładką ${hits} · nowe zapytania ${asked}\n`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stderr.write(`Gotowe: ${data.recs.length} filmów, z okładką ${hits}, nowe dopasowania ${asked}\n`);
if (cachePath) writeFileSync(cachePath, JSON.stringify(cache));
process.stdout.write(JSON.stringify(data));
