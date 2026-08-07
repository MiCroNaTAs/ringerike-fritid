#!/usr/bin/env node
/**
 * Henter og slår sammen fritidstilbud for Ringerike kommune fra:
 *  1. Frivillighetsregisteret (via Brønnøysundregistrenes åpne Enhetsregister-API)
 *  2. Ringerike kommunes side for fritidsaktiviteter (beste-innsats HTML-skraping)
 *  3. Manuelt kuraterte tilbud (src/data/manual-tilbud.json)
 * Resultatet skrives til src/data/tilbud.json + src/data/meta.json, som konsumeres
 * av Astro-sidene ved bygg. Ment å kjøres periodisk av en GitHub Action.
 *
 * Skriptet er skrevet for å aldri kaste bort tidligere data ved en forbigående
 * feil hos én kilde: hvis en kilde feiler, beholdes forrige kjørings data for
 * akkurat den kilden, og feilen logges i meta.json.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'src', 'data');
const TILBUD_PATH = path.join(DATA_DIR, 'tilbud.json');
const META_PATH = path.join(DATA_DIR, 'meta.json');
const MANUAL_PATH = path.join(DATA_DIR, 'manual-tilbud.json');
const OVERRIDES_PATH = path.join(DATA_DIR, 'overrides.json');

const KOMMUNENUMMER = '3305'; // Ringerike kommune (gjeldende nummer siden 2024-01-01)
const BRREG_API = 'https://data.brreg.no/enhetsregisteret/api/enheter';
const KOMMUNE_FRITID_URL = 'https://www.ringerike.kommune.no/innhold/kultur-og-idrett/kulturenheten/fritidsaktiviteter/';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BRREG_PAGES = 20; // sikkerhetstak, ca. 2000 enheter

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// --- Kategorisering (heuristisk, kan overstyres per organisasjonsnummer i overrides.json) ---

const NACE_KATEGORI = [
  { prefix: '93.1', kategori: 'idrett' },
  { prefix: '93.2', kategori: 'idrett' },
  { prefix: '85.51', kategori: 'idrett' },
  { prefix: '90', kategori: 'kultur' },
  { prefix: '85.52', kategori: 'kultur' },
  { prefix: '91', kategori: 'kultur' },
  { prefix: '94.99', kategori: 'frivillighet' },
  { prefix: '88.99', kategori: 'frivillighet' },
  { prefix: '88.91', kategori: 'frivillighet' },
  { prefix: '94.91', kategori: 'frivillighet' },
];

const KEYWORD_KATEGORI = [
  { kategori: 'idrett', ord: ['idrett', 'ball', 'sport', 'ski', 'turn', 'svøm', 'sykkel', 'skytter', 'friidrett', 'kampsport', 'håndball', 'fotball'] },
  { kategori: 'kultur', ord: ['kultur', 'kor', 'musikk', 'teater', 'dans', 'kunst', 'korps', 'revy', 'orkester'] },
  { kategori: 'frivillighet', ord: ['røde kors', 'sanitet', 'speider', 'vel', 'velforening', 'menighet', 'lions', 'rotary', 'frivillig', 'ungdomsklubb', 'grendelag'] },
];

const ALDERSGRUPPE_KEYWORD = [
  { gruppe: 'barn', ord: ['barn', 'junior', 'familie', '4h'] },
  { gruppe: 'unge', ord: ['ungdom', 'unge', 'ungdomsklubb', 'russ'] },
  { gruppe: 'voksne', ord: ['senior', 'pensjonist', 'eldre', 'voksne'] },
];

function kategoriserFraNaeringskode(naeringskode) {
  if (!naeringskode?.kode) return null;
  const kode = naeringskode.kode;
  const treff = NACE_KATEGORI.find((n) => kode.startsWith(n.prefix));
  return treff?.kategori ?? null;
}

function kategoriserFraTekst(tekst) {
  const lav = tekst.toLowerCase();
  for (const { kategori, ord } of KEYWORD_KATEGORI) {
    if (ord.some((o) => lav.includes(o))) return kategori;
  }
  return null;
}

function finnAldersgrupper(tekst) {
  const lav = tekst.toLowerCase();
  const treff = ALDERSGRUPPE_KEYWORD.filter(({ ord }) => ord.some((o) => lav.includes(o))).map((t) => t.gruppe);
  return treff.length > 0 ? treff : ['barn', 'unge', 'voksne']; // ukjent -> vis for alle
}

// --- Kilde 1: Frivillighetsregisteret via Brreg Enhetsregisteret ---

async function hentBrregEnheter() {
  const enheter = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages && page < MAX_BRREG_PAGES) {
    const url = new URL(BRREG_API);
    url.searchParams.set('kommunenummer', KOMMUNENUMMER);
    url.searchParams.set('registrertIFrivillighetsregisteret', 'true');
    url.searchParams.set('size', '100');
    url.searchParams.set('page', String(page));

    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`Brreg API svarte ${res.status} ${res.statusText} for ${url}`);
    }
    const json = await res.json();
    const batch = json._embedded?.enheter ?? [];
    enheter.push(...batch);
    totalPages = json.page?.totalPages ?? 1;
    page += 1;
  }

  return enheter.map((e) => {
    const adresse = e.forretningsadresse;
    const tekstForKategorisering = [e.navn, e.naeringskode1?.beskrivelse].filter(Boolean).join(' ');
    const kategori =
      kategoriserFraNaeringskode(e.naeringskode1) ?? kategoriserFraTekst(tekstForKategorisering) ?? 'frivillighet';

    return {
      id: `brreg-${e.organisasjonsnummer}`,
      navn: e.navn,
      beskrivelse: e.naeringskode1?.beskrivelse ?? null,
      kategori,
      aldersgruppe: finnAldersgrupper(e.navn),
      adresse: adresse?.adresse?.join(', ') || null,
      poststed: adresse ? [adresse.postnummer, adresse.poststed].filter(Boolean).join(' ') : null,
      nettside: null,
      epost: null,
      telefon: null,
      organisasjonsnummer: e.organisasjonsnummer,
      kilde: 'frivillighetsregisteret',
      kildeUrl: `https://virksomhet.brreg.no/nb/oppslag/enheter/${e.organisasjonsnummer}`,
    };
  });
}

// --- Kilde 2: Ringerike kommunes fritidsaktiviteter-side (beste-innsats skraping) ---

const STOEY_LENKETEKST = new Set([
  'les mer', 'kontakt oss', 'til toppen', 'skriv ut', 'del', 'forrige', 'neste',
  'hjem', 'startside', 'søk', 'meny', 'vis alle', 'se alle', 'abonner',
]);

async function hentKommuneFritidstilbud() {
  const res = await fetchWithTimeout(KOMMUNE_FRITID_URL, {
    headers: { Accept: 'text/html', 'User-Agent': 'ringerike-fritid-oversikt/1.0 (+https://github.com/MiCroNaTAs/ringerike-fritid)' },
  });
  if (!res.ok) {
    throw new Error(`Kommunesiden svarte ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const contentSelectors = ['main', '#main-content', 'article', '.article-content', '#content', 'body'];
  let $content = null;
  for (const sel of contentSelectors) {
    if ($(sel).length && $(sel).text().trim().length > 200) {
      $content = $(sel).first();
      break;
    }
  }
  if (!$content) $content = $('body');

  const resultater = [];
  const settHrefs = new Set();

  $content.find('a[href]').each((_, el) => {
    const $el = $(el);
    const tekst = $el.text().trim().replace(/\s+/g, ' ');
    const href = $el.attr('href');
    if (!href || !tekst) return;
    if (tekst.length < 4 || tekst.length > 120) return;
    if (STOEY_LENKETEKST.has(tekst.toLowerCase())) return;
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;

    let absolutt;
    try {
      absolutt = new URL(href, KOMMUNE_FRITID_URL).toString();
    } catch {
      return;
    }
    if (settHrefs.has(absolutt)) return;
    settHrefs.add(absolutt);

    const kategori = kategoriserFraTekst(tekst) ?? 'annet';
    resultater.push({
      id: `kommune-${hashStr(absolutt)}`,
      navn: tekst,
      beskrivelse: null,
      kategori,
      aldersgruppe: finnAldersgrupper(tekst),
      adresse: null,
      poststed: 'Ringerike',
      nettside: absolutt,
      epost: null,
      telefon: null,
      organisasjonsnummer: null,
      kilde: 'ringerike-kommune',
      kildeUrl: KOMMUNE_FRITID_URL,
    });
  });

  return resultater;
}

// --- Kilde 3: Manuelt kuraterte tilbud ---

async function hentManuelleTilbud() {
  const manuelle = await readJson(MANUAL_PATH, []);
  return manuelle.map((m) => ({
    id: m.id ?? `manuell-${slugify(m.navn)}`,
    navn: m.navn,
    beskrivelse: m.beskrivelse ?? null,
    kategori: m.kategori ?? 'annet',
    aldersgruppe: m.aldersgruppe?.length ? m.aldersgruppe : ['barn', 'unge', 'voksne'],
    adresse: m.adresse ?? null,
    poststed: m.poststed ?? null,
    nettside: m.nettside ?? null,
    epost: m.epost ?? null,
    telefon: m.telefon ?? null,
    organisasjonsnummer: m.organisasjonsnummer ?? null,
    kilde: 'manuell',
    kildeUrl: null,
  }));
}

// --- Overstyringer (rettelser per id/organisasjonsnummer) ---

function anvendOverstyringer(tilbud, overstyringer) {
  return tilbud.map((t) => {
    const nokkel = t.organisasjonsnummer ? `orgnr:${t.organisasjonsnummer}` : t.id;
    const overstyring = overstyringer[nokkel] ?? overstyringer[t.id];
    return overstyring ? { ...t, ...overstyring } : t;
  });
}

// --- Hovedlogikk ---

async function main() {
  const naa = new Date().toISOString();
  const eksisterende = await readJson(TILBUD_PATH, []);
  const eksisterendeMeta = await readJson(META_PATH, {
    sistOppdatert: null,
    antallTotalt: 0,
    kilder: {
      frivillighetsregisteret: { antall: 0, hentet: null, feil: null },
      ringerikeKommune: { antall: 0, hentet: null, feil: null },
      manuell: { antall: 0, hentet: null, feil: null },
    },
  });
  const overstyringer = await readJson(OVERRIDES_PATH, {});

  const kildeResultat = { frivillighetsregisteret: null, ringerikeKommune: null, manuell: null };
  const meta = { sistOppdatert: naa, antallTotalt: 0, kilder: structuredClone(eksisterendeMeta.kilder) };

  // Kilde 1: Frivillighetsregisteret
  try {
    kildeResultat.frivillighetsregisteret = await hentBrregEnheter();
    meta.kilder.frivillighetsregisteret = { antall: kildeResultat.frivillighetsregisteret.length, hentet: naa, feil: null };
    console.log(`[frivillighetsregisteret] hentet ${kildeResultat.frivillighetsregisteret.length} enheter`);
  } catch (err) {
    console.error('[frivillighetsregisteret] feilet, beholder forrige data:', err.message);
    kildeResultat.frivillighetsregisteret = eksisterende.filter((t) => t.kilde === 'frivillighetsregisteret');
    meta.kilder.frivillighetsregisteret = {
      ...eksisterendeMeta.kilder.frivillighetsregisteret,
      feil: `${naa}: ${err.message}`,
    };
  }

  // Kilde 2: Ringerike kommune (best effort)
  try {
    kildeResultat.ringerikeKommune = await hentKommuneFritidstilbud();
    meta.kilder.ringerikeKommune = { antall: kildeResultat.ringerikeKommune.length, hentet: naa, feil: null };
    console.log(`[ringerike-kommune] hentet ${kildeResultat.ringerikeKommune.length} lenker`);
  } catch (err) {
    console.error('[ringerike-kommune] feilet, beholder forrige data:', err.message);
    kildeResultat.ringerikeKommune = eksisterende.filter((t) => t.kilde === 'ringerike-kommune');
    meta.kilder.ringerikeKommune = {
      ...eksisterendeMeta.kilder.ringerikeKommune,
      feil: `${naa}: ${err.message}`,
    };
  }

  // Kilde 3: Manuelle tilbud
  try {
    kildeResultat.manuell = await hentManuelleTilbud();
    meta.kilder.manuell = { antall: kildeResultat.manuell.length, hentet: naa, feil: null };
  } catch (err) {
    console.error('[manuell] feilet, beholder forrige data:', err.message);
    kildeResultat.manuell = eksisterende.filter((t) => t.kilde === 'manuell');
    meta.kilder.manuell = { ...eksisterendeMeta.kilder.manuell, feil: `${naa}: ${err.message}` };
  }

  let alleTilbud = [
    ...kildeResultat.frivillighetsregisteret,
    ...kildeResultat.ringerikeKommune,
    ...kildeResultat.manuell,
  ];

  alleTilbud = anvendOverstyringer(alleTilbud, overstyringer);
  alleTilbud.sort((a, b) => a.navn.localeCompare(b.navn, 'nb'));

  meta.antallTotalt = alleTilbud.length;

  await writeFile(TILBUD_PATH, JSON.stringify(alleTilbud, null, 2) + '\n', 'utf-8');
  await writeFile(META_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

  console.log(`Ferdig. ${alleTilbud.length} tilbud totalt skrevet til ${path.relative(process.cwd(), TILBUD_PATH)}`);
}

main().catch((err) => {
  console.error('Uventet feil i fetch-data.mjs:', err);
  process.exitCode = 1;
});
