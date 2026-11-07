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
// Gość widzi najwyżej 500 wyników jednego wyszukiwania (dalej: 401 „Restricted offset for guest users”).
const GUEST_MAX = 500;
// Przedział z większą liczbą wyników dzielimy na wyszukiwania po pierwszej literze tytułu.
// Polskie litery są osobno („s” ≠ „ś”), cyfry też.
const LETTERS = [...'abcdefghijklmnopqrstuvwxyz0123456789', 'ć', 'ł', 'ó', 'ś', 'ź', 'ż'];
// Przeciążony katalog ucina zapytanie po ~30 s i zwraca pustą listę. Po jednym zapytaniu naraz
// (jak w jedynym w pełni udanym przebiegu) katalog odpowiada w ~8 s. Można podnieść zmienną CONCURRENCY.
const START_CONCURRENCY = Number(process.env.CONCURRENCY || 1);
const DELAY_MS = Number(process.env.DELAY_MS || 500);   // przerwa po każdej stronie
const THROTTLE_PAUSE_MS = Number(process.env.THROTTLE_PAUSE_MS || 60_000); // przerwa po blokadzie (rośnie przy kolejnych)
const MAX_REQUEUE = 5;        // tyle razy ponawiamy jedną stronę, zanim ją pominiemy

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

async function search(jwt, { term, from, to, offset, prefix }) {
  const params = new URLSearchParams({
    inst: INST, vid: VID, tab: 'LibraryCatalog', scope: 'MyInstitution2', lang: 'pl',
    limit: String(PAGE), offset: String(offset),
    sort: 'title', // stała kolejność; "rank" potrafi się przetasować między zapytaniami
    getMore: '0', pcAvailability: 'false', skipDelivery: 'N', rtaLinks: 'true', disableCache: 'false',
    q: prefix ? `any,contains,${term},AND;title,begins_with,${prefix}` : `any,contains,${term}`,
    qInclude: `facet_rtype,exact,${RTYPE}|,|facet_searchcreationdate,exact,[${from} TO ${to}]`,
  });
  const res = await fetch(`${HOST}/primaws/rest/pub/pnxs?${params}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) { const e = new Error(`pnxs HTTP ${res.status} (${from}-${to}${prefix ? ' ' + prefix + '…' : ''} @${offset})`); e.status = res.status; throw e; }
  return res.json();
}

// ---------- porządkowanie danych z katalogu ----------

// Katalog dokleja do tytułu ekipę i wytwórnie ("... directed by ...", "reżyseria ...").
const CREDITS = /\s+(?:(?:a\s+)?film\s+by|produced|production|presents|directed|written|screenplay|created|reżyseria|scenariusz|Disney|HBO|Warner|Universal|Paramount|Netflix|Sony|Lionsgate|Studio)\b.*$/i;
const cut = (s) => (s || '').split(' / ')[0].split(' ; ')[0].replace(CREDITS, '')
  .replace(/\s*[\[(]film[\])]\s*/gi, ' ').replace(ORIG_PREFIX, '')
  .replace(/\s+reż\.[\s,:].*$/i, '').replace(/\s+scen\.[\s,:].*$/i, '').replace(/\s+film\s+\p{Lu}[\p{L}-]+(?:\s+\p{Lu}[\p{L}-]+)+\.?$/u, '')
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


// ---------- łączenie wydań ----------
// Ta sama praca w kilku wydaniach (inne lata płyty, DVD i Blu-ray) to w katalogu osobne rekordy.
// Łączymy je po tytule i reżyserze (filmy) albo wykonawcy (muzyka); bez twórcy także po roku.
const keyNorm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
  .replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
function creatorKey(r) {
  const who = r.d?.[0] || '';
  if (!who) return '';
  const surname = who.includes(',') ? who.split(',')[0] : who.split(/\s+/).pop();
  return keyNorm(surname);
}
function groupEditions(recs) {
  // najpierw po tytule, potem w obrębie tytułu po twórcy
  const byTitle = new Map();
  for (const r of recs) {
    const k = keyNorm(r.t);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(r);
  }
  const groups = new Map();
  for (const [tk, list] of byTitle) {
    const withWho = new Map(), without = [];
    for (const r of list) {
      const who = creatorKey(r);
      if (!who) { without.push(r); continue; }
      if (!withWho.has(who)) withWho.set(who, []);
      withWho.get(who).push(r);
    }
    // wydanie bez twórcy dołącza do jedynego twórcy o tym tytule; inaczej łączymy je tylko po roku
    if (withWho.size === 1) [...withWho.values()][0].push(...without);
    else for (const r of without) {
      const yk = 'y' + r.y;
      if (!withWho.has(yk)) withWho.set(yk, []);
      withWho.get(yk).push(r);
    }
    for (const [who, g] of withWho) groups.set(`${tk}|${who}`, g);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.length === 1) { const r = g[0]; out.push({ ...r, fs: [r.f] }); continue; }
    // główny rekord: najwięcej egzemplarzy, potem najnowsze wydanie
    g.sort((a, b) => b.h.length - a.h.length || Number(b.y || 0) - Number(a.y || 0));
    const main = g[0];
    const byLib = new Map();
    for (const r of g) for (const [code, ok] of r.h) byLib.set(code, Math.max(byLib.get(code) ?? 0, ok));
    const years = g.map((r) => Number(r.y)).filter(Boolean);
    out.push({
      ...main,
      o: main.o || g.find((r) => r.o)?.o,
      y: years.length ? String(Math.min(...years)) : main.y,
      g: main.g.length ? main.g : (g.find((r) => r.g.length)?.g || []),
      c: main.c?.length ? main.c : g.find((r) => r.c?.length)?.c,
      fs: [...new Set(g.map((r) => r.f))],
      h: [...byLib.entries()],
      alt: g.slice(1).map((r) => [r.id, r.y, r.f]),
    });
  }
  return out;
}

// ---------- główna pętla ----------

async function main() {
  const lastYear = Number(process.argv[2] || new Date().getFullYear());
  const started = Date.now();
  const mins = () => ((Date.now() - started) / 60000).toFixed(1);
  // Token gościa jest ważny 24 h; nowy pobieramy tylko po odmowie.
  let jwt = await guestJwt();
  const toRecord = MUSIC ? musicRecord : filmRecord;
  const records = new Map();
  const libs = {};
  const sliceTotal = new Map();      // liczba wyników przedziału z jego pierwszej strony
  let errors = 0, pagesDone = 0, pagesKnown = 0, throttles = 0;
  let concurrency = START_CONCURRENCY, pauseUntil = 0;

  const queue = [];
  for (const [from, to] of yearRanges(lastYear)) for (const term of TERMS) queue.push({ term, from, to, offset: 0, tries: 0 });
  pagesKnown = queue.length;

  const label = (t) => `${t.from === t.to ? t.from : t.from + '-' + t.to}${t.prefix ? ' „' + t.prefix + '…”' : ''}`;

  async function throttled(task, why) {
    throttles++;
    const pause = Math.min(THROTTLE_PAUSE_MS * 2 ** Math.min(throttles - 1, 3), 8 * 60_000);
    pauseUntil = Math.max(pauseUntil, Date.now() + pause);
    if (concurrency > 1) concurrency = 1;
    task.tries++;
    if (task.tries > MAX_REQUEUE) {
      errors++;
      log(`[${mins()} min] POMINIĘTO ${label(task)} @${task.offset} po ${MAX_REQUEUE} próbach (${why})\n`);
      if (errors > 40) throw new Error('Za dużo pominiętych stron, przerywam.');
      return;
    }
    log(`[${mins()} min] katalog nie odpowiedział (${why}); przerwa ${pause / 1000} s, potem ponawiam tę stronę\n`);
    queue.unshift(task);             // ta sama strona wraca na początek kolejki
    try { jwt = await guestJwt(); } catch {}
  }

  async function runTask(task) {
    const wait = pauseUntil - Date.now();
    if (wait > 0) await sleep(wait);
    let json;
    try {
      json = await search(jwt, task);
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 429 || e.status >= 500 || !e.status) return throttled(task, e.message);
      throw e;
    }
    if (json.errorCode) {
      log(`[${mins()} min] katalog odpowiedział: ${json.errorMessage || json.errorCode} (${label(task)} @${task.offset})\n`);
      pagesDone++;
      return;
    }
    const total = json.info?.total ?? 0;
    const n = (json.docs || []).length;
    const sk = `${task.from}-${task.to}|${task.term}|${task.prefix || ''}`;
    const known = sliceTotal.get(sk);
    // Pusta odpowiedź tam, gdzie wcześniej były wyniki = blokada, nie koniec danych.
    if (task.offset > 0 && (total === 0 || n === 0)) return throttled(task, 'pusta strona w środku wyników');
    // Pusty przedział sprawdzamy jeszcze raz na końcu kolejki (bez przerwy): bywa prawdziwy, bywa blokadą.
    if (task.offset === 0 && total === 0 && !task.rechecked) { queue.push({ ...task, rechecked: true }); return; }
    const expected = Math.min(PAGE, (known ?? total) - task.offset);
    if (n < expected && task.tries < MAX_REQUEUE) return throttled(task, `niepełna strona ${n}/${expected}`);

    pagesDone++;
    if (task.offset === 0) {
      sliceTotal.set(sk, total);
      if (!task.prefix && total > GUEST_MAX) {
        // za dużo dla gościa: ten przedział pobieramy literami (pierwsza strona i tak się przyda)
        for (const L of LETTERS) { queue.push({ ...task, prefix: L, offset: 0, tries: 0, rechecked: true }); pagesKnown++; }
        log(`${label(task)}: ${total} wyników > ${GUEST_MAX}, dzielę na ${LETTERS.length} wyszukiwań po pierwszej literze tytułu\n`);
      } else {
        if (total > GUEST_MAX) log(`Uwaga: ${label(task)} ma ${total} wyników, pobiorę tylko pierwsze ${GUEST_MAX}\n`);
        for (let off = PAGE; off < Math.min(total, GUEST_MAX); off += PAGE) { queue.push({ ...task, offset: off, tries: 0 }); pagesKnown++; }
      }
    }
    for (const d of json.docs || []) {
      const rec = toRecord(d, task.from, task.to, libs);
      if (rec && !records.has(rec.id)) records.set(rec.id, rec);
    }
    log(`[${mins()} min] strony ${pagesDone}/${pagesKnown} · ${label(task)} @${task.offset}/${total} → ${records.size} rekordów\n`);
  }

  await new Promise((resolve, reject) => {
    let active = 0, failed = false;
    const next = () => {
      if (failed) return;
      if (!queue.length && active === 0) return resolve();
      while (active < concurrency && queue.length) {
        const task = queue.shift();
        active++;
        runTask(task)
          .then(() => sleep(DELAY_MS))
          .then(() => { active--; next(); }, (e) => { failed = true; reject(e); });
      }
    };
    next();
  });

  const merged = groupEditions([...records.values()]);
  log(`Gotowe w ${mins()} min: ${records.size} rekordów → ${merged.length} po połączeniu wydań, ${pagesDone} stron, blokad: ${throttles}, pominiętych stron: ${errors}\n`);
  process.stdout.write(JSON.stringify({ kind: MUSIC ? 'music' : 'films', harvestedAt: new Date().toISOString(), libs, recs: merged }));
}

main().catch((e) => { console.error(e); process.exit(1); });
