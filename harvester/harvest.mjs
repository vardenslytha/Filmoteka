// Harvester katalogu Primo VE (Biblioteka Raczyńskich) – filmy i muzyka na płytach.
// Uruchom: node harvest.mjs [rokOd] [rokDo] > films.json   (Node 18+, bez zależności)
// Zapisuje kompaktowe rekordy z dostępnością egzemplarzy per filia.

const HOST = 'https://omnis-br.primo.exlibrisgroup.com';
const INST = '48OMNIS_BRP';
const VID = '48OMNIS_BRP:BRACZ';
const RTYPE = process.env.RTYPE || 'videos'; // 'videos' (filmy) albo 'audios' (muzyka)
const TERMS = RTYPE === 'videos' ? ['film', 'reżyseria'] : ['muzyka', 'cd'];
const PAGE = 50;
const OFFSET_LIMIT = 1950; // Primo odrzuca offset powyżej ~2000
const DELAY_MS = 400;      // bądź uprzejmy dla serwera biblioteki

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function guestJwt() {
  const url = `${HOST}/primaws/rest/pub/institution/${INST}/guestJwt?isGuest=true&lang=pl&viewId=${encodeURIComponent(VID)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`guestJwt HTTP ${res.status}`);
  return (await res.text()).replace(/"/g, '');
}

async function search(jwt, { term, year, offset }) {
  const params = new URLSearchParams({
    inst: INST, vid: VID, tab: 'LibraryCatalog', scope: 'MyInstitution2', lang: 'pl',
    limit: String(PAGE), offset: String(offset), sort: 'rank', getMore: '0',
    pcAvailability: 'false', skipDelivery: 'N', rtaLinks: 'true', disableCache: 'false',
    q: `any,contains,${term}`,
    qInclude: `facet_rtype,exact,${RTYPE}|,|facet_searchcreationdate,exact,[${year} TO ${year}]`,
  });
  const res = await fetch(`${HOST}/primaws/rest/pub/pnxs?${params}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`pnxs HTTP ${res.status} (${term} ${year} @${offset})`);
  return res.json();
}

// Katalog dokleja do tytułu ekipę i wytwórnie ("... directed by ...", "reżyseria ...").
const CREDITS = /\s+(?:(?:a\s+)?film\s+by|produced|production|presents|directed|written|screenplay|created|reżyseria|scenariusz|Disney|HBO|Warner|Universal|Paramount|Netflix|Sony|Lionsgate|Studio)\b.*$/i;
const cut = (s) => (s || '').split(' / ')[0].split(' ; ')[0].replace(CREDITS, '')
  .replace(/\s*\[film\]\s*/gi, ' ').replace(/^Tytuł oryginału:\s*/i, '')
  .replace(/,\s*\d{4}$/, '').replace(/\s*:\s*$/, '').replace(/\s+/g, ' ').trim();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Zwraca [tytuł polski, tytuł oryginalny]. TMDB poprawia potem przypadki, których to nie rozplącze.
function splitTitles(title, addtitle) {
  if (addtitle?.includes(' = ')) { const [a, b] = addtitle.split(' = '); return [cut(a), cut(b)]; }
  if (title?.includes(' = ')) { const [a, b] = title.split(' = '); return [cut(a), cut(b)]; }
  if (/^Tytuł oryginału:/i.test(title || '')) return [cut(addtitle), cut(title)];
  if (addtitle) {
    const pl = cut(addtitle);
    let orig = cut(title);
    const i = orig.toLowerCase().lastIndexOf(pl.toLowerCase());
    if (i > 0) orig = orig.slice(0, i).trim();
    return [pl, orig.toLowerCase() === pl.toLowerCase() ? '' : orig];
  }
  return [cut(title), ''];
}

function toRecord(doc, year, libs) {
  const p = doc.pnx.display;
  const id = p.mms?.[0];
  if (!id) return null;
  const directors = (p.contributor || [])
    .filter((c) => /Reżyseria/.test(c))
    .map((c) => c.split(/ Reżyseria| \(|\$\$/)[0].replace(/\s*(Produkcja|\.)$/, '').trim())
    .filter(Boolean);
  const holdings = (doc.delivery?.holding || []).map((h) => {
    libs[h.libraryCode] = `${h.mainLocation || ''}|${(h.subLocation || '').trim()}`;
    return [h.libraryCode, h.availabilityStatus === 'available' ? 1 : 0];
  });
  let [pl, orig] = splitTitles(p.title?.[0], p.addtitle?.[0]);
  if (!pl) [pl, orig] = [orig, ''];
  return {
    id,
    t: cap(pl),
    o: orig ? cap(orig) : undefined,
    y: (p.lds05?.[0] || p.creationdate?.[0] || '').replace(/\D/g, '').slice(0, 4) || String(year),
    g: (p.genre || []).filter((g) => !/Adaptacja|Sequel|^Film fabularny$|Dokumenty audiowizualne/.test(g)).slice(0, 3),
    c: (p.lds08 || []).map((s) => s.replace('Film ', '')).filter((s) => /(ski|cki|zki)$/.test(s)).slice(0, 2),
    a: p.lds07?.[0] || '',
    d: directors.slice(0, 2),
    f: /Blu-ray/i.test(p.format?.[0] || '') ? 'BD' : RTYPE === 'videos' ? 'DVD' : 'CD',
    h: holdings,
  };
}

async function main() {
  const from = Number(process.argv[2] || 2000);
  const to = Number(process.argv[3] || new Date().getFullYear());
  let jwt = await guestJwt();
  const records = new Map();
  const libs = {};

  for (let year = from; year <= to; year++) {
    for (const term of TERMS) {
      for (let offset = 0; offset <= OFFSET_LIMIT; offset += PAGE) {
        let json;
        try {
          json = await search(jwt, { term, year, offset });
        } catch (e) {
          // token wygasł albo chwilowy błąd – odśwież i spróbuj raz jeszcze
          await sleep(2000);
          jwt = await guestJwt();
          json = await search(jwt, { term, year, offset });
        }
        const docs = json.docs || [];
        for (const d of docs) {
          const rec = toRecord(d, year, libs);
          if (rec && !records.has(rec.id)) records.set(rec.id, rec);
        }
        process.stderr.write(`\r${year} ${term} +${offset} → ${records.size} rekordów`);
        if (docs.length < PAGE) break;
        await sleep(DELAY_MS);
      }
    }
  }
  process.stderr.write('\n');
  process.stdout.write(JSON.stringify({ harvestedAt: new Date().toISOString(), libs, recs: [...records.values()] }));
}

main().catch((e) => { console.error(e); process.exit(1); });
