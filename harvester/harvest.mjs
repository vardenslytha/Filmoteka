// Harvester katalogu Primo VE (Biblioteka Raczyńskich) – filmy i muzyka na płytach.
// Uruchom (Node 18+, bez zależności):
//   RTYPE=videos node harvest.mjs > films.json     (filmy i seriale)
//   RTYPE=audios node harvest.mjs > music.json     (muzyka; audiobooki są pomijane)
// Opcjonalnie rok końcowy jako argument: node harvest.mjs 2026

const HOST = 'https://omnis-br.primo.exlibrisgroup.com';
const INST = '48OMNIS_BRP';
const VID = '48OMNIS_BRP:BRACZ';
const RTYPE = process.env.RTYPE || 'videos';
const MUSIC = RTYPE === 'audios';
// Jedno zapytanie z OR zamiast kilku przebiegów: katalog zwraca sumę wyników.
// Test (2016 filmy / 2010 muzyka): samo "film" 596 → z OR 602; samo "muzyka" 793 → z OR 831. Dalsze słowa nic nie dodają.
const TERMS = MUSIC
  ? ['muzyka OR wykonanie OR i OR cd OR w OR the OR z']
  : ['film OR reżyseria OR i OR dvd OR w OR na OR z'];
const PAGE = 100;          // 100 wyników trwa tyle co 50, więc o połowę mniej zapytań
const OFFSET_LIMIT = 1900; // Primo odrzuca offset powyżej ~2000
const CONCURRENCY = 4;     // 4 zapytania naraz trwają tyle co jedno; 8 już zwalnia
const DELAY_MS = 250;      // przerwa po każdej stronie, bądź uprzejmy dla serwera biblioteki
const TOKEN_TTL_MS = 90_000; // token gościa wygasa po kilku minutach (HTTP 401)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(s);

// Przedziały lat: starsze lata mają mało rekordów, więc łączymy je w paczki.
function yearRanges(to) {
  const r = MUSIC
    ? [[1900, 1949], ...range(1950, to).map((y) => [y, y])]
    : [[1900, 1959], [1960, 1979], [1980, 1989], [1990, 1999], ...range(2000, to).map((y) => [y, y])];
  return r;
}
function range(a, b) { const out = []; for (let y = a; y <= b; y++) out.push(y); return out; }

async function guestJwt() {
  const url = `${HOST}/primaws/rest/pub/institution/${INST}/guestJwt?isGuest=true&lang=pl&viewId=${encodeURIComponent(VID)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`guestJwt HTTP ${res.status}`);
  return (await res.text()).replace(/"/g, '');
}

async function search(jwt, { term, from, to, offset }) {
  const params = new URLSearchParams({
    inst: INST, vid: VID, tab: 'LibraryCatalog', scope: 'MyInstitution2', lang: 'pl',
    limit: String(PAGE), offset: String(offset),
    sort: 'title', // stała kolejność; "rank" potrafi się przetasować między zapytaniami
    getMore: '0', pcAvailability: 'false', skipDelivery: 'N', rtaLinks: 'true', disableCache: 'false',
    q: `any,contains,${term}`,
    qInclude: `facet_rtype,exact,${RTYPE}|,|facet_searchcreationdate,exact,[${from} TO ${to}]`,
  });
  const res = await fetch(`${HOST}/primaws/rest/pub/pnxs?${params}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`pnxs HTTP ${res.status} (${term} ${from}-${to} @${offset})`);
  return res.json();
}

// ---------- porządkowanie danych z katalogu ----------

// Katalog dokleja do tytułu ekipę i wytwórnie ("... directed by ...", "reżyseria ...").
const CREDITS = /\s+(?:(?:a\s+)?film\s+by|produced|production|presents|directed|written|screenplay|created|reżyseria|scenariusz|Disney|HBO|Warner|Universal|Paramount|Netflix|Sony|Lionsgate|Studio)\b.*$/i;
const cut = (s) => (s || '').split(' / ')[0].split(' ; ')[0].replace(CREDITS, '')
  .replace(/\s*[\[(]film[\])]\s*/gi, ' ').replace(ORIG_PREFIX, '')
  .replace(/\s+reż\.\s.*$/i, '').replace(/\s+film\s+\p{Lu}[\p{L}-]+(?:\s+\p{Lu}[\p{L}-]+)+\.?$/u, '')
  .replace(/,\s*\d{4}$/, '').replace(/\s*:\s*$/, '').replace(/\s+/g, ' ').trim();
const ORIG_PREFIX = /^(?:Tytuł oryginału|Tyt\.?\s*oryg\.?)\s*:\s*/i;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const person = (s) => (s || '').split('$$')[0].replace(/\s*\(\d{4}-?\s*\d*\s*\)/g, '')
  .replace(/\s*\((zespół muzyczny|aktor(ka)?|.*?)\)/gi, '')
  .replace(/\s+(Wykonanie|Aranżacja|Dyrygent|Kompozytor|Tekst|Produkcja|Reżyseria|Scenariusz|Redakcja)\b.*$/i, '')
  .replace(/[.,]\s*$/, '').trim();
const MAX_YEAR = new Date().getFullYear() + 1;
const okYear = (y) => y >= 1888 && y <= MAX_YEAR;
// Rok z rekordu; literówki w katalogu (np. 20, 200, 2102) zastępujemy rokiem przedziału, jeśli przedział to jeden rok.
function year(p, from, to) {
  for (const raw of [p.lds05?.[0], p.creationdate?.[0]]) {
    const y = Number((raw || '').replace(/\D/g, '').slice(0, 4));
    if (okYear(y)) return String(y);
  }
  return from === to ? String(from) : '';
}

// Zwraca [tytuł polski, tytuł oryginalny]. TMDB poprawia potem przypadki, których to nie rozplącze.
function splitTitles(title, addtitle) {
  if (addtitle?.includes(' = ')) { const [a, b] = addtitle.split(' = '); return [cut(a), cut(b)]; }
  if (title?.includes(' = ')) { const [a, b] = title.split(' = '); return [cut(a), cut(b)]; }
  if (ORIG_PREFIX.test(title || '')) return [cut(addtitle), cut(title)];
  if (addtitle) {
    const pl = cut(addtitle);
    let orig = cut(title);
    const i = orig.toLowerCase().lastIndexOf(pl.toLowerCase());
    if (i > 0) orig = orig.slice(0, i).trim();
    return [pl, orig.toLowerCase() === pl.toLowerCase() ? '' : orig];
  }
  return [cut(title), ''];
}

function holdingsOf(doc, libs) {
  return (doc.delivery?.holding || []).map((h) => {
    libs[h.libraryCode] = `${h.mainLocation || ''}|${(h.subLocation || '').trim()}`;
    return [h.libraryCode, h.availabilityStatus === 'available' ? 1 : 0];
  });
}

function filmRecord(doc, from, to, libs) {
  const p = doc.pnx.display;
  const id = p.mms?.[0];
  if (!id) return null;
  const directors = (p.contributor || []).filter((c) => /Reżyseria/.test(c)).map(person).filter(Boolean);
  let [pl, orig] = splitTitles(p.title?.[0], p.addtitle?.[0]);
  if (!pl) [pl, orig] = [orig, ''];
  return {
    id,
    t: cap(pl),
    o: orig && orig.toLowerCase() !== pl.toLowerCase() ? cap(orig) : undefined,
    y: year(p, from, to),
    g: (p.genre || []).filter((g) => !/Adaptacja|Sequel|^Film fabularny$|Dokumenty audiowizualne/.test(g)).slice(0, 3),
    c: (p.lds08 || []).map((s) => s.replace('Film ', '')).filter((s) => /(ski|cki|zki)$/.test(s)).slice(0, 2),
    a: p.lds07?.[0] || '',
    d: [...new Set(directors)].slice(0, 2),
    f: /Blu-?ray/i.test(p.format?.[0] || '') ? 'BD' : 'DVD',
    h: holdingsOf(doc, libs),
  };
}

function musicFormat(fmt) {
  if (/analog|gramofon|winyl|vinyl|\bLP\b|33 obr/i.test(fmt)) return 'LP';
  if (/kaset|\bMC\b/i.test(fmt)) return 'MC';
  if (/SACD/i.test(fmt)) return 'SACD';
  return 'CD';
}

// Role w opisach muzyki, także w skrótach ("Dyr", "Reż. nagr").
const ROLE = /\s+(?:Wykonanie|Wyk\.|Aranżacja|Aranż\.|Dyrygent|Dyr\.?|Kompozytor|Kompoz\w*\.?|Komp\.|Tekst|Słowa|Muzyka|Produkcja|Prod\.|Reżyseria|Reż\.|Scenariusz|Redakcja|Red\.|Realizacja|Oprac\w*|Nagranie|Mastering)\b.*$/;
const BACKSTAGE = /\s(?:Reż\.\s*nagr|Realizacja|Produkcja|Prod\.|Mastering|Nagranie|Redakcja|Oprac|Wydawca|Dystrybucja)/;

// "Miller, Marcus" → "Marcus Miller"; "Ukrainians, The" → "The Ukrainians"
function displayName(raw) {
  const n = person(raw).replace(ROLE, '').replace(/[.,]\s*$/, '').trim();
  const m = n.match(/^([^,]+),\s*([^,]+)$/);
  if (!m) return n;
  return `${m[2]} ${m[1]}`;
}

function musicRecord(doc, from, to, libs) {
  const p = doc.pnx.display;
  const id = p.mms?.[0];
  if (!id) return null;
  const cats = (p.lds04 || []).join(' ');
  const genres = p.genre || p.lds12 || [];
  // tylko muzyka: bez audiobooków, prozy i słuchowisk (rekordy bez kategorii zostają)
  if (/Audiobook|Proza|Książka mówiona|Słuchowisk/i.test(cats) && !/Muzyka/.test(cats)) return null;
  if (genres.some((g) => /Audiobook|Słuchowisko|Powieść|Opowiadani/i.test(g)) && !/Muzyka/.test(cats)) return null;
  const performers = [
    ...(p.creator || []),
    ...(p.contributor || []).filter((c) => !BACKSTAGE.test(c)),
  ].map(displayName).filter((n) => n && n.length > 1);
  const uniq = [...new Set(performers)];
  let title = cut((p.title?.[0] || '').split(' / ')[0].replace(/\s*:\s*/, ': '));
  // katalog dokleja wykonawcę na końcu tytułu: "25 Adele.", "Amandla Miles Davis."
  title = title.replace(/\.\s*$/, '');
  for (const n of uniq) {
    const variants = [n, n.replace(/^The\s+/i, '')];
    for (const v of variants) {
      if (v && title.length > v.length + 1 && title.toLowerCase().endsWith(' ' + v.toLowerCase())) {
        title = title.slice(0, -v.length).trim().replace(/[.,:;]\s*$/, '');
      }
    }
  }
  return {
    id,
    t: cap(title || (p.title?.[0] || '').slice(0, 80)),
    y: year(p, from, to),
    g: genres.filter((g) => !/^Muzyka$/.test(g)).slice(0, 3),
    d: uniq.slice(0, 2),
    f: musicFormat(p.format?.[0] || ''),
    h: holdingsOf(doc, libs),
  };
}

// ---------- główna pętla ----------

async function main() {
  const lastYear = Number(process.argv[2] || new Date().getFullYear());
  const started = Date.now();
  // Token gościa wygasa po kilku minutach, więc odświeżamy go zawczasu; jedno odświeżenie naraz.
  let jwt = await guestJwt();
  let jwtAt = Date.now();
  let refreshing = null;
  const freshJwt = async (force = false) => {
    if (force || Date.now() - jwtAt > TOKEN_TTL_MS) {
      refreshing ||= guestJwt().then((t) => { jwt = t; jwtAt = Date.now(); }).finally(() => { refreshing = null; });
      await refreshing;
    }
    return jwt;
  };
  const toRecord = MUSIC ? musicRecord : filmRecord;
  const records = new Map();
  const libs = {};
  let errors = 0, pagesDone = 0, pagesKnown = 0;

  async function fetchPage({ term, from, to, offset }) {
    // do 3 prób z rosnącą przerwą; przy każdym błędzie nowy token
    for (const [attempt, wait] of [[1, 0], [2, 3000], [3, 15000]]) {
      try {
        if (wait) await sleep(wait);
        const json = await search(await freshJwt(attempt > 1), { term, from, to, offset });
        if (json.errorCode) return json;
        const n = (json.docs || []).length;
        const expected = Math.min(PAGE, (json.info?.total ?? 0) - offset);
        // niepełna strona przed końcem wyników = chwilowy błąd, spróbuj jeszcze raz
        if (n < expected && attempt < 3) continue;
        return json;
      } catch (e) {
        if (attempt === 3) {
          errors++;
          log(`\nPominięto ${from}-${to} „${term}” od ${offset}: ${e.message}\n`);
          if (errors > 40) throw new Error('Za dużo błędów katalogu, przerywam.');
        }
      }
    }
    return null;
  }

  // Kolejka stron: najpierw pierwsza strona każdego przedziału, kolejne dopisujemy, gdy znamy liczbę wyników.
  const queue = [];
  for (const [from, to] of yearRanges(lastYear)) for (const term of TERMS) queue.push({ term, from, to, offset: 0 });
  pagesKnown = queue.length;

  async function runTask(task) {
    const json = await fetchPage(task);
    pagesDone++;
    if (!json) return;
    if (json.errorCode) {
      log(`\nKatalog odpowiedział: ${json.errorMessage || json.errorCode} (${task.from}-${task.to} ${task.term} @${task.offset})\n`);
      return;
    }
    const total = json.info?.total ?? 0;
    if (task.offset === 0) {
      if (total > OFFSET_LIMIT + PAGE) log(`\nUwaga: ${task.from}-${task.to} „${task.term}” ma ${total} wyników, pobiorę tylko pierwsze ${OFFSET_LIMIT + PAGE}\n`);
      for (let off = PAGE; off < total && off <= OFFSET_LIMIT; off += PAGE) { queue.push({ ...task, offset: off }); pagesKnown++; }
    }
    for (const d of json.docs || []) {
      const rec = toRecord(d, task.from, task.to, libs);
      if (rec && !records.has(rec.id)) records.set(rec.id, rec);
    }
    const min = ((Date.now() - started) / 60000).toFixed(1);
    log(`[${min} min] strony ${pagesDone}/${pagesKnown} · ${task.from === task.to ? task.from : task.from + '-' + task.to} @${task.offset}/${total} → ${records.size} rekordów\n`);
  }

  // CONCURRENCY zapytań naraz; katalog przetwarza ok. 4 równolegle bez spowolnienia
  await new Promise((resolve, reject) => {
    let active = 0;
    const next = () => {
      if (!queue.length && active === 0) return resolve();
      while (active < CONCURRENCY && queue.length) {
        const task = queue.shift();
        active++;
        runTask(task)
          .then(() => sleep(DELAY_MS))
          .then(() => { active--; next(); }, (e) => reject(e));
      }
    };
    next();
  });

  log(`Gotowe w ${((Date.now() - started) / 60000).toFixed(1)} min: ${records.size} rekordów, ${pagesDone} stron, błędów: ${errors}\n`);
  process.stdout.write(JSON.stringify({ kind: MUSIC ? 'music' : 'films', harvestedAt: new Date().toISOString(), libs, recs: [...records.values()] }));
}

main().catch((e) => { console.error(e); process.exit(1); });
