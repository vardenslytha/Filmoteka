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

const cache = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IMG = 'https://image.tmdb.org/t/p/w342';
const RETRY_MISSES_AFTER_DAYS = 30;

async function tmdb(path, params) {
  const qs = new URLSearchParams({ api_key: KEY, language: 'pl-PL', ...params });
  const res = await fetch(`https://api.themoviedb.org/3${path}?${qs}`);
  if (res.status === 429) { await sleep(2000); return tmdb(path, params); }
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status} ${path}`);
  return res.json();
}

const isSeries = (r) => /Serial filmowy/.test((r.g || []).join()) || /Sezon/i.test(r.t);
const clean = (s) => (s || '').replace(/\.\s*Sezon.*$/i, '').replace(/:\s*kolekcja.*$/i, '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
const yearOf = (x) => Number((x.release_date || x.first_air_date || '').slice(0, 4));

async function match(r) {
  const kind = isSeries(r) ? 'tv' : 'movie';
  const year = Number(r.y) || 0;
  for (const q of [...new Set([clean(r.o), clean(r.t)].filter(Boolean))]) {
    const { results = [] } = await tmdb(`/search/${kind}`, { query: q, include_adult: 'false' });
    if (!results.length) continue;
    if (kind === 'tv' || !year) return { kind, hit: results[0] };
    // rok na płycie bywa rokiem wydania DVD, czyli rok po premierze
    const near = results.filter((x) => Math.abs(yearOf(x) - year) <= 1);
    if (near.length) return { kind, hit: near[0] };
  }
  return null;
}

const now = Date.now();
let asked = 0, hits = 0;
for (const [i, r] of data.recs.entries()) {
  let c = cache[r.id];
  const stale = c && c.miss && now - c.at > RETRY_MISSES_AFTER_DAYS * 864e5;
  if (!c || stale) {
    try {
      const m = await match(r);
      asked++;
      c = m
        ? { at: now, kind: m.kind, id: m.hit.id,
            title: m.hit.title || m.hit.name || '', orig: m.hit.original_title || m.hit.original_name || '',
            poster: m.hit.poster_path ? IMG + m.hit.poster_path : null,
            rating: m.hit.vote_average ? Math.round(m.hit.vote_average * 10) / 10 : null,
            votes: m.hit.vote_count || 0, overview: (m.hit.overview || '').slice(0, 600) }
        : { at: now, miss: true };
      cache[r.id] = c;
      await sleep(60); // TMDB pozwala na ~40 zapytań/s
    } catch (e) { console.error(`\n${r.t}: ${e.message}`); continue; }
  }
  if (c && !c.miss) {
    hits++;
    // Tytuł z katalogu bywa pomieszany; polski tytuł z TMDB jest czystszy.
    if (c.kind === 'movie' && c.title) { r.t = c.title; r.o = c.orig && c.orig !== c.title ? c.orig : undefined; }
    r.tmdb = { id: c.id, kind: c.kind, poster: c.poster, rating: c.rating, votes: c.votes, overview: c.overview };
  }
  process.stderr.write(`\r${i + 1}/${data.recs.length} · z okładką ${hits} · nowe zapytania ${asked}`);
}
process.stderr.write('\n');
if (cachePath) writeFileSync(cachePath, JSON.stringify(cache));
process.stdout.write(JSON.stringify(data));
