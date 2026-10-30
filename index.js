#!/usr/bin/env node
/**
 * index.js — append Lat/Lon columns to a CSV that has City/State/Country columns.
 *
 * Usage:
 *   node index.js [options] <input.csv | glob> [more inputs...]
 *
 * Run with --help for details.
 *
 * Geocoding is fully local, using the free GeoNames dump (CC-BY 4.0,
 * https://download.geonames.org/export/dump/). On first run the script
 * downloads ~10MB into ./data/ ; after that it works offline.
 *
 * Lookup order per row:
 *   1. postal code (US ZIP or Canadian postal code, if a Zip/Postal column exists)
 *   2. city + state + country   (state may be a code like "OH" or a full name)
 *   3. city + country
 *   4. country fallback (capital city, else most populous city in the country)
 *
 * Exception: rural Canadian FSAs (x0x) are region-sized, so an exact
 * city+province match outranks them; the FSA centroid stays as the fallback.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Where the downloaded GeoNames data lives. Priority:
//   1. $OFFLINE_CSV_GEOCODER_DATA_DIR (explicit override)
//   2. ./data next to the script, if it already exists or __dirname is writable
//      (keeps local/dev checkouts self-contained)
//   3. a per-user cache dir (for global npm installs where __dirname is read-only)
function resolveDataDir() {
  if (process.env.OFFLINE_CSV_GEOCODER_DATA_DIR) return process.env.OFFLINE_CSV_GEOCODER_DATA_DIR;
  const local = path.join(__dirname, 'data');
  if (fs.existsSync(local)) return local;
  try {
    fs.accessSync(__dirname, fs.constants.W_OK);
    return local;
  } catch {
    const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    return path.join(base, 'offline-csv-geocoder');
  }
}
const DATA_DIR = resolveDataDir();
const GEONAMES_BASE = 'https://download.geonames.org/export/dump/';
const GEONAMES_ZIP_BASE = 'https://download.geonames.org/export/zip/';
const FILES = {
  cities: 'cities500.txt',
  citiesZip: 'cities500.zip',
  admin1: 'admin1CodesASCII.txt',
  countryInfo: 'countryInfo.txt',
};
// Postal-code datasets (same GeoNames CC-BY 4.0 source). Each zip contains
// <CC>.txt; the CA file is FSA-level (first 3 characters of the postal code).
// US territories (PR/VI/GU/AS/MP) ship as separate GeoNames tables but are
// labeled "United States" in the data, so they're merged into the US map.
const POSTAL_FILES = {
  US: { zip: 'US.zip', txt: 'US.txt', local: 'zip_US.txt' },
  PR: { zip: 'PR.zip', txt: 'PR.txt', local: 'zip_PR.txt' },
  VI: { zip: 'VI.zip', txt: 'VI.txt', local: 'zip_VI.txt' },
  GU: { zip: 'GU.zip', txt: 'GU.txt', local: 'zip_GU.txt' },
  AS: { zip: 'AS.zip', txt: 'AS.txt', local: 'zip_AS.txt' },
  MP: { zip: 'MP.zip', txt: 'MP.txt', local: 'zip_MP.txt' },
  CA: { zip: 'CA.zip', txt: 'CA.txt', local: 'zip_CA.txt' },
};
// Which postal tables feed each in-memory map (US mainland + territories).
const ZIP_US_SOURCES = ['US', 'PR', 'VI', 'GU', 'AS', 'MP'];
const ZIP_CA_SOURCES = ['CA'];

// ---------------------------------------------------------------- data fetch

async function download(url, dest) {
  console.log(`Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

async function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const citiesTxt = path.join(DATA_DIR, FILES.cities);
  if (!fs.existsSync(citiesTxt)) {
    const zipPath = path.join(DATA_DIR, FILES.citiesZip);
    if (!fs.existsSync(zipPath)) {
      await download(GEONAMES_BASE + FILES.citiesZip, zipPath);
    }
    console.log('Extracting cities500.zip ...');
    execFileSync('unzip', ['-o', zipPath, '-d', DATA_DIR], { stdio: 'ignore' });
    if (!fs.existsSync(citiesTxt)) throw new Error('unzip did not produce cities500.txt');
    fs.unlinkSync(zipPath);
  }

  for (const f of [FILES.admin1, FILES.countryInfo]) {
    const dest = path.join(DATA_DIR, f);
    if (!fs.existsSync(dest)) await download(GEONAMES_BASE + f, dest);
  }

  for (const pf of Object.values(POSTAL_FILES)) {
    const dest = path.join(DATA_DIR, pf.local);
    if (fs.existsSync(dest)) continue;
    const zipPath = path.join(DATA_DIR, pf.zip);
    if (!fs.existsSync(zipPath)) {
      await download(GEONAMES_ZIP_BASE + pf.zip, zipPath);
    }
    console.log(`Extracting ${pf.zip} ...`);
    // -p: extract just <CC>.txt to stdout (both zips also carry a readme.txt)
    const txt = execFileSync('unzip', ['-p', zipPath, pf.txt], { maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(dest, txt);
    fs.unlinkSync(zipPath);
  }
}

// ------------------------------------------------------------- normalization

function normalize(s) {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/\bst[.]?\s/g, 'saint ')
    .replace(/\bste[.]?\s/g, 'sainte ')
    .replace(/\bft[.]?\s/g, 'fort ')
    .replace(/\bmt[.]?\s/g, 'mount ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Legitimate country-name variants GeoNames doesn't use verbatim. These are
// real alternate names, not data-entry errors — for dataset-specific typos
// (e.g. "United Sates") supply a JSON map via --aliases; see aliases.example.json.
const COUNTRY_ALIASES = {
  'usa': 'US', 'us': 'US', 'united states of america': 'US',
  'uk': 'GB', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB',
  'great britain': 'GB', 'northern ireland': 'GB',
  'south korea': 'KR', 'north korea': 'KP', 'republic of korea': 'KR',
  'ivory coast': 'CI', 'cote d ivoire': 'CI',
  'dr congo': 'CD', 'democratic republic of congo': 'CD',
  'democratic republic of the congo': 'CD', 'congo kinshasa': 'CD',
  'republic of congo': 'CG', 'congo brazzaville': 'CG',
  'burma': 'MM', 'myanmar burma': 'MM',
  'east timor': 'TL', 'cape verde': 'CV', 'swaziland': 'SZ',
  'macedonia': 'MK', 'czech republic': 'CZ', 'turkey': 'TR',
  'russia': 'RU', 'vietnam': 'VN', 'laos': 'LA', 'syria': 'SY',
  'iran': 'IR', 'bolivia': 'BO', 'venezuela': 'VE', 'tanzania': 'TZ',
  'moldova': 'MD', 'brunei': 'BN', 'vatican city': 'VA',
  'palestine': 'PS', 'the gambia': 'GM', 'the bahamas': 'BS',
  'westbank gaza': 'PS', 'west bank': 'PS', 'gaza': 'PS',
  'somaliland': 'SO',
};

// --------------------------------------------------------------- geo indexes

function buildIndexes({ extraAliases = {} } = {}) {
  // country name -> ISO2
  const countryByName = new Map();
  const capitalByCountry = new Map(); // ISO2 -> normalized capital name
  for (const line of fs.readFileSync(path.join(DATA_DIR, FILES.countryInfo), 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const c = line.split('\t');
    const iso = c[0];
    countryByName.set(normalize(c[4]), iso);
    if (c[5]) capitalByCountry.set(iso, normalize(c[5]));
  }
  // Built-in aliases fill gaps only (never shadow an official GeoNames name);
  // user-supplied --aliases are applied after and DO override, so a dataset can
  // remap a name if it needs to.
  for (const [alias, iso] of Object.entries(COUNTRY_ALIASES)) {
    if (!countryByName.has(alias)) countryByName.set(alias, iso);
  }
  for (const [alias, iso] of Object.entries(extraAliases)) {
    countryByName.set(normalize(alias), iso);
  }

  // admin1 (state/province): "CC.CODE\tName\tAsciiName\tgeonameid"
  // map  CC|normalized-name -> CODE   (codes themselves, like "OH", pass through)
  const admin1ByName = new Map();
  for (const line of fs.readFileSync(path.join(DATA_DIR, FILES.admin1), 'utf8').split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    const [cc, code] = c[0].split('.');
    admin1ByName.set(`${cc}|${normalize(c[1])}`, code);
    admin1ByName.set(`${cc}|${normalize(c[2])}`, code);
  }
  // GeoNames numbers Canadian provinces (ON = CA.08), so the usual
  // pass-through of state codes never matches; bridge the postal
  // abbreviations to the numeric codes via the province names.
  const CA_PROVINCES = {
    ab: 'alberta', bc: 'british columbia', mb: 'manitoba',
    nb: 'new brunswick', nl: 'newfoundland and labrador', nf: 'newfoundland and labrador',
    ns: 'nova scotia', nt: 'northwest territories', nu: 'nunavut',
    on: 'ontario', pe: 'prince edward island', pei: 'prince edward island',
    qc: 'quebec', pq: 'quebec', sk: 'saskatchewan', yt: 'yukon',
  };
  for (const [abbr, name] of Object.entries(CA_PROVINCES)) {
    const code = admin1ByName.get(`CA|${name}`);
    if (code && !admin1ByName.has(`CA|${abbr}`)) admin1ByName.set(`CA|${abbr}`, code);
  }

  // cities500.txt (tab-separated):
  // 0 id, 1 name, 2 asciiname, 3 alternatenames, 4 lat, 5 lon, ...,
  // 8 country code, 10 admin1 code, 14 population
  const byCityAdmin = new Map();   // CC|A1|name -> entry
  const byCity = new Map();        // CC|name    -> entry
  const biggestInCountry = new Map(); // CC -> entry (most populous city)

  // prefer primary-name matches over alternate-name matches, then higher population
  const put = (map, key, entry) => {
    const prev = map.get(key);
    if (!prev || entry.prio > prev.prio || (entry.prio === prev.prio && entry.pop > prev.pop)) {
      map.set(key, entry);
    }
  };

  const lines = fs.readFileSync(path.join(DATA_DIR, FILES.cities), 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    const c = line.split('\t');
    const lat = c[4], lon = c[5], cc = c[8], a1 = c[10];
    const pop = parseInt(c[14], 10) || 0;

    const names = new Set([normalize(c[1]), normalize(c[2])]);
    names.delete('');
    for (const n of names) {
      const e = { lat, lon, pop, prio: 1 };
      put(byCity, `${cc}|${n}`, e);
      if (a1) put(byCityAdmin, `${cc}|${a1}|${n}`, e);
    }
    // alternate names only for larger cities (keeps memory reasonable,
    // still catches things like "Bombay" or local-language spellings)
    if (pop >= 50000 && c[3]) {
      for (const alt of c[3].split(',')) {
        const n = normalize(alt);
        if (!n || names.has(n)) continue;
        const e = { lat, lon, pop, prio: 0 };
        put(byCity, `${cc}|${n}`, e);
        if (a1) put(byCityAdmin, `${cc}|${a1}|${n}`, e);
      }
    }

    const big = biggestInCountry.get(cc);
    if (!big || pop > big.pop) biggestInCountry.set(cc, { lat, lon, pop });
  }

  // country fallback coordinate: capital if we can find it, else biggest city
  const countryFallback = new Map();
  for (const [cc, big] of biggestInCountry) {
    const cap = capitalByCountry.get(cc);
    const capEntry = cap ? byCity.get(`${cc}|${cap}`) : null;
    countryFallback.set(cc, capEntry || big);
  }

  // postal codes: US ZIP -> coords, and Canadian FSA (first 3 chars) -> coords.
  // GeoNames zip format: 0 country, 1 postal code, ..., 9 lat, 10 lon
  const zipUS = new Map();
  const zipCA = new Map();
  for (const { sources, map, isCA } of [
    { sources: ZIP_US_SOURCES, map: zipUS, isCA: false },
    { sources: ZIP_CA_SOURCES, map: zipCA, isCA: true },
  ]) {
    for (const key of sources) {
      for (const line of fs.readFileSync(path.join(DATA_DIR, POSTAL_FILES[key].local), 'utf8').split('\n')) {
        if (!line) continue;
        const c = line.split('\t');
        if (c[9] && c[10]) {
          const code = c[1].toUpperCase();
          // Canadian rural FSAs (second char 0) are region-sized; flag them so
          // lookup() can prefer an exact city+province match when one exists.
          map.set(code, { lat: c[9], lon: c[10], src: 'zip', rural: isCA && code[1] === '0' });
        }
      }
    }
  }

  return { countryByName, admin1ByName, byCityAdmin, byCity, countryFallback, zipUS, zipCA };
}

// Resolve a raw Zip/Postal-column value against the US and Canadian postal
// indexes. `cc` (resolved ISO2 country, or null) scopes the search; with no
// usable country we fall back to inferring it from the value's format.
function zipLookup(idx, zip, cc) {
  if (!zip) return null;
  const z = String(zip).trim().toUpperCase();

  // US ZIP: 5 digits, allowing ZIP+4 and 3-4 digit values whose leading
  // zeros were stripped by a spreadsheet (re-padded only when the row's
  // country is the US: a bare 4-digit code is as likely Austrian or Swiss)
  const us = z.match(/^(\d{3,5})(?:[- ]\d{4})?$/);
  if (us && (cc === 'US' || (!cc && us[1].length === 5))) {
    const hit = idx.zipUS.get(us[1].padStart(5, '0'));
    if (hit) return hit;
  }

  // Canadian postal code: match on the FSA (first 3 characters), tolerating
  // missing spaces and truncated/mangled tails like "T0B 1G"
  const ca = z.replace(/[^A-Z0-9]/g, '').match(/^([A-Z]\d[A-Z])/);
  if (ca && (!cc || cc === 'CA')) {
    const hit = idx.zipCA.get(ca[1]);
    if (hit) return hit;
  }

  return null;
}

// Optimal-string-alignment edit distance (a transposition counts as one edit).
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// A close misspelling of a long US name ("United Sates", "Unites States").
// Short forms like "USA" are left out: two edits from a 3-letter name is
// another country.
function looksLikeUS(countryN) {
  return ['united states', 'united states of america'].some((u) => editDistance(countryN, u) <= 2);
}

function lookup(idx, { city, state, country, zip }) {
  const countryN = normalize(country);
  const cc = idx.countryByName.get(countryN) || null;

  // Postal scope: the resolved country; with a blank country the code's
  // format decides. A non-blank country we can't resolve is trusted as the
  // US only when it is a close misspelling of a US name (and then, as for a
  // blank country, a Canadian-format code still finds its FSA); otherwise
  // the postal code is not used and the row ends up under Unmatched.
  let zipHit = null;
  if (cc || !countryN) zipHit = zipLookup(idx, zip, cc);
  else if (looksLikeUS(countryN)) zipHit = zipLookup(idx, zip, 'US') || zipLookup(idx, zip, null);
  // Urban postal hits are neighborhood-precise and win outright. A rural
  // Canadian FSA centroid can sit far from the actual town, so for those we
  // prefer an exact city+province match and keep the FSA as the fallback.
  if (zipHit && !zipHit.rural) return zipHit;

  if (!cc) return zipHit;

  const cityN = normalize(city);
  if (cityN) {
    // resolve state to an admin1 code: try as a code first (e.g. "OH"), then as a name
    if (state) {
      const stateRaw = state.trim().toUpperCase();
      const stateCode = idx.admin1ByName.get(`${cc}|${normalize(state)}`) ||
        (/^[A-Z0-9]{1,3}$/.test(stateRaw) ? stateRaw : null);
      if (stateCode) {
        const hit = idx.byCityAdmin.get(`${cc}|${stateCode}|${cityN}`);
        if (hit) return hit;
      }
    }
    // A bare city+country match can land on a same-named town in another
    // province (Lethbridge AB vs NL) — the very error the FSA corrects — so
    // it never outranks a rural zip hit.
    if (!zipHit) {
      const hit = idx.byCity.get(`${cc}|${cityN}`);
      if (hit) return hit;
    }
  }

  return zipHit || idx.countryFallback.get(cc) || null;
}

// ----------------------------------------------------------------- CSV utils

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCsvLine(fields) {
  return fields.map(f => {
    f = String(f ?? '');
    return /[",\n\r]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f;
  }).join(',');
}

// ------------------------------------------------------------------ CLI args

const HELP = `offline-csv-geocoder — append Lat/Lon columns to CSVs with City/State/Country columns.

Usage:
  offline-csv-geocoder [options] <input.csv | glob> [more inputs...]

Globs like "test input/*.csv" are expanded by the script, so quoting them is fine.

Options:
  -o, --output <path>   Single input: output file path.
                        Multiple inputs: output directory (created if needed).
      --no-overwrite    Skip inputs whose output file already exists
                        (default is to overwrite).
      --city-col <h>    Override auto-detected column headers. Each takes a
      --state-col <h>   column header name (case-insensitive) or a 1-based
      --country-col <h> index. Only --country (or a Zip/Postal column) is
      --zip-col <h>     required; the rest are optional.
      --aliases <file>  JSON map of country name -> ISO2 code for dataset-
                        specific spellings/typos, e.g. {"United Sates":"US"}.
                        Merged on top of the built-in aliases (and overrides
                        them). See aliases.example.json.
  -h, --help            Show this help.

Without --output, each result is written next to its input as
<name>_with_latlon.csv. Globs never match *_with_latlon.csv files, so
re-running on the same directory won't reprocess previous output.

Column auto-detection (when not overridden): City/State/Country match those
header names case-insensitively; the postal column is any header mentioning
"Zip" or "Postal" (so "Updated Zip" works).

Lookup order per row: postal code (US ZIP or Canadian postal code), then
city+state+country, then city+country, then country fallback (capital, else
most populous city). Exception: rural Canadian FSAs (x0x) are region-sized, so
an exact city+province match outranks them. Data comes from the free GeoNames
dump, downloaded once and used offline after that.`;

function parseArgs(argv) {
  const opts = { inputs: [], output: null, overwrite: true, cols: {}, aliases: {} };
  const colFlags = {
    '--city-col': 'city', '--state-col': 'state',
    '--country-col': 'country', '--zip-col': 'zip',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log(HELP);
      process.exit(0);
    } else if (a === '-o' || a === '--output') {
      opts.output = argv[++i];
      if (!opts.output) fail('--output requires a path');
    } else if (a === '--no-overwrite') {
      opts.overwrite = false;
    } else if (colFlags[a]) {
      const v = argv[++i];
      if (!v) fail(`${a} requires a column name or index`);
      opts.cols[colFlags[a]] = v;
    } else if (a === '--aliases') {
      const f = argv[++i];
      if (!f) fail('--aliases requires a path to a JSON file');
      opts.aliases = loadAliases(f);
    } else if (a.startsWith('-')) {
      fail(`Unknown option: ${a}`);
    } else {
      const matched = expandGlob(a);
      if (!matched.length) fail(`No input files matched: ${a}`);
      opts.inputs.push(...matched);
    }
  }
  return opts;
}

function loadAliases(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`Could not read --aliases file ${file}: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`--aliases file ${file} must be a JSON object of "name": "ISO2" pairs`);
  }
  return raw;
}

// Exit codes: 0 ok, 1 partial (not currently emitted: the tool stops at the first
// failure), 2 usage (UsageError), 3 could not complete (anything else thrown).
class UsageError extends Error {}

function fail(msg) {
  throw new UsageError(msg);
}

function die(err) {
  if (err instanceof UsageError) {
    console.error(err.message);
    console.error('Try offline-csv-geocoder --help for usage.');
    process.exit(2);
  }
  console.error(`error: ${String((err && err.message) || err).split('\n')[0]}`);
  process.exit(3);
}

// Minimal glob: supports * and ? in the filename part (not in directories).
function expandGlob(pattern) {
  if (!/[*?]/.test(pattern)) return [pattern];
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  const re = new RegExp('^' +
    base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') +
    '$');
  if (!fs.existsSync(dir)) return [];
  // never glob-match our own output files, so re-runs don't reprocess them
  return fs.readdirSync(dir)
    .filter(f => re.test(f) && !/_with_latlon\.csv$/i.test(f)).sort()
    .map(f => path.join(dir, f));
}

// ----------------------------------------------------------------------- main

function defaultOutputPath(inputPath) {
  return path.join(path.dirname(inputPath),
    path.basename(inputPath, path.extname(inputPath)) + '_with_latlon.csv');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.inputs.length) fail('No input files matched.');
  for (const f of opts.inputs) {
    if (!fs.existsSync(f)) fail(`Input file not found: ${f}`);
    if (!fs.statSync(f).isFile()) fail(`Input path is not a file: ${f}`);
  }

  // map each input to its output path
  let outFor;
  if (opts.output && opts.inputs.length > 1) {
    fs.mkdirSync(opts.output, { recursive: true });
    outFor = (f) => path.join(opts.output, defaultOutputPath(path.basename(f)));
  } else if (opts.output) {
    outFor = () => opts.output;
  } else {
    outFor = defaultOutputPath;
  }

  const work = [];
  for (const inputPath of opts.inputs) {
    const outputPath = outFor(inputPath);
    if (!opts.overwrite && fs.existsSync(outputPath)) {
      console.log(`Skipping ${inputPath} (${outputPath} exists, --no-overwrite)`);
      continue;
    }
    work.push([inputPath, outputPath]);
  }
  if (!work.length) {
    console.log('Nothing to do.');
    return;
  }

  await ensureData();
  console.log('Building geo index ...');
  const idx = buildIndexes({ extraAliases: opts.aliases });

  for (const [inputPath, outputPath] of work) {
    processFile(idx, inputPath, outputPath, opts.cols);
  }
}

// Resolve a column override: a 1-based index, or a header name matched
// case-insensitively. Returns a 0-based index, or -1 if not found.
function resolveCol(header, spec, inputPath) {
  if (/^\d+$/.test(spec)) {
    const i = parseInt(spec, 10) - 1;
    if (i < 0 || i >= header.length) throw new UsageError(`Column index ${spec} out of range in ${inputPath}`);
    return i;
  }
  const want = spec.trim().toLowerCase();
  const i = header.findIndex(h => h.trim().toLowerCase() === want);
  if (i === -1) throw new UsageError(`Column "${spec}" not found in ${inputPath}`);
  return i;
}

function processFile(idx, inputPath, outputPath, cols = {}) {
  const rows = parseCsv(fs.readFileSync(inputPath, 'utf8').replace(/^﻿/, ''));
  if (!rows.length) throw new Error(`Empty input CSV: ${inputPath}`);

  const header = rows[0];
  const auto = (name) => header.findIndex(h => h.trim().toLowerCase() === name);
  // explicit override wins; otherwise auto-detect
  const cityCol = cols.city ? resolveCol(header, cols.city, inputPath) : auto('city');
  const stateCol = cols.state ? resolveCol(header, cols.state, inputPath) : auto('state');
  const countryCol = cols.country ? resolveCol(header, cols.country, inputPath) : auto('country');
  // any column mentioning zip/postal, e.g. "Zip", "Updated Zip", "Postal Code"
  const zipCol = cols.zip ? resolveCol(header, cols.zip, inputPath) : header.findIndex(h => /\b(zip|postal)\b/i.test(h));
  if (countryCol === -1 && zipCol === -1) {
    throw new Error(`No "Country" or Zip/Postal column found in ${inputPath} (use --country-col / --zip-col to specify)`);
  }

  const out = [toCsvLine([...header, 'Lat', 'Lon'])];
  let matched = 0, viaZip = 0, cityMisses = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0] === '') continue; // trailing blank line
    const city = cityCol !== -1 ? row[cityCol] : '';
    const state = stateCol !== -1 ? row[stateCol] : '';
    const country = countryCol !== -1 ? row[countryCol] : '';
    const zip = zipCol !== -1 ? row[zipCol] : '';

    const hit = lookup(idx, { city, state, country, zip });
    if (hit) {
      matched++;
      if (hit.src === 'zip') viaZip++;
    } else if (country || city || zip) {
      cityMisses.push(`${city}, ${state}, ${country}${zip ? ` [zip: ${zip}]` : ''}`);
    }
    out.push(toCsvLine([...row, hit ? hit.lat : '', hit ? hit.lon : '']));
  }

  fs.writeFileSync(outputPath, out.join('\n') + '\n');
  const total = out.length - 1;
  console.log(`Wrote ${outputPath}`);
  console.log(`Geocoded ${matched}/${total} rows.${viaZip ? ` (${viaZip} via postal code)` : ''}`);
  if (cityMisses.length) {
    console.log(`Unmatched (${cityMisses.length}):`);
    for (const m of [...new Set(cityMisses)].slice(0, 20)) console.log(`  - ${m}`);
  }
}

// Run only as a CLI, so require() from another program can't exit its host.
if (require.main === module) {
  process.on('uncaughtException', die);
  main().catch(die);
}
