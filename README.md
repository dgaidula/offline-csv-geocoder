# offline-csv-geocoder

**Offline** forward geocoder (no API key, no rate limits, **zero npm
dependencies**) that appends `Lat` and `Lon` columns to a CSV using the `City`,
`State`, and `Country` columns — with **US ZIP and Canadian postal-code
precision** when a Zip/Postal column is present. One file.

It fills a specific gap: the offline geocoders on npm are almost all *reverse*
(coordinates → place), and the CSV batch tools are online-only and need an API
key. This does *forward*, offline, CSV-native geocoding with postal precision.

```sh
npx offline-csv-geocoder input.csv                        # writes input_with_latlon.csv
npx offline-csv-geocoder input.csv -o out.csv             # explicit output file
npx offline-csv-geocoder "data/*.csv" -o results/         # glob in, output directory
npx offline-csv-geocoder --help
```

Or install it: `npm i -g offline-csv-geocoder`, then run `offline-csv-geocoder ...`.

**Hardened:** 2026-10-30 · dfb042b · gate CLOSED WITH FOLLOW-UPS

## What it's good for

Batch-geocoding spreadsheets of organizations, grant recipients, mailing lists,
survey responses — anything with city/state/country (and ideally a ZIP/postal)
column — when you want coordinates without sending the data to a third-party API
or paying per row. Great for air-gapped/offline environments and large one-off
files.

**Accuracy is centroid-level, not rooftop.** A US ZIP resolves to the ZIP's
centroid; a Canadian postal code resolves to its FSA (first three characters, a
postal district); city matches resolve to the city centroid. That's ideal for
mapping, regional aggregation, and radius queries down to a few miles — it is
*not* street-address geocoding.

## Lookup order (per row)

1. **Postal code** — US ZIP or Canadian postal code, from any column whose header
   mentions "Zip" or "Postal" (so `Updated Zip`, `Postal Code`, etc. all work).
2. **City + State + Country** — state may be a code (`OH`, `BC`) or full name
   (`Ohio`, `British Columbia`).
3. **City + Country**.
4. **Country fallback** — the capital's coordinates, else the most populous city.

Rows that match nothing get empty Lat/Lon and are listed (deduped) in the console
summary: the first 20 distinct rows, then a `... and N more distinct rows` line.

### Which country a postal code belongs to

The row’s Country cell decides which postal table is tried:

- **A recognized country** (a GeoNames name or a built-in or `--aliases` alias)
  scopes the lookup: US ZIPs for the United States, FSAs for Canada, and no
  postal lookup for any other country (its rows use city and country).
- **A blank country** lets the code’s format decide: a 5-digit or ZIP+4 value is
  read as a US ZIP, an `A1A` value as a Canadian FSA.
- **An unrecognized country that is a close misspelling of “United States”**
  (at most two edits, such as “United Sates” or “Untied States”) is treated as
  the US, and a Canadian-format code still finds its FSA, as for a blank country.
- **Any other unrecognized country** (`Deutschland`, `España`) never uses the
  postal code: the row is listed under “Unmatched”, where an `--aliases` entry
  fixes it. A German `10115` or Spanish `28001` is never placed in the US.

### Real-world-data handling baked in

- **US territories** (Puerto Rico, US Virgin Islands, Guam, American Samoa,
  Northern Marianas) are labeled "United States" in most data but live in
  separate GeoNames tables — they're merged in, so `San Juan, PR 00921` lands in
  the Caribbean, not San Juan, Texas.
- **Rural Canadian FSAs** (`x0x`) cover whole regions, so for those an exact
  city+province match is preferred and the FSA centroid is the fallback. This
  also corrects same-named towns across provinces (Lethbridge AB vs NL).
- **Excel-stripped leading zeros** — a ZIP that arrived as `4029` is re-padded to
  `04029` when the country is the United States (a bare 4-digit code with a
  blank country could as well be Austrian or Swiss, so it is not re-padded).
- **ZIP+4** (`37402-1234`) and spaced/truncated Canadian codes (`V9A 2R3`,
  `T0B 1G`) are tolerated.
- **UTF-8 BOM** on the header row is stripped.
- Garbage postal values (`NA`, UK postcodes) fall through to the city/country
  path instead of failing the row.

## Options

```
-o, --output <path>    Single input: output file. Multiple inputs: a directory.
    --no-overwrite     Skip any input whose output already exists.
    --city-col <h>     Override column detection. Each accepts a header name
    --state-col <h>    (case-insensitive) or a 1-based column index. Only a
    --country-col <h>  Country column OR a Zip/Postal column is required; the
    --zip-col <h>      rest are optional.
    --aliases <file>   JSON map of country name -> ISO2 for dataset-specific
                       spellings/typos (see below).
-h, --help
```

With multiple inputs, `--output` is treated as a directory. Without `--output`,
each result is written next to its input as `<name>_with_latlon.csv`. Globs
(`*`, `?`) are expanded by the tool and never match `*_with_latlon.csv`, so
re-running on a directory won't reprocess previous output.

### Column detection

By default: `City`/`State`/`Country` are matched by those header names
(case-insensitive), and the postal column is any header containing "zip" or
"postal". If your headers differ, point at them explicitly:

```sh
offline-csv-geocoder --country-col Nation --city-col Municipality --zip-col "Post Code" input.csv
offline-csv-geocoder --country-col 2 --state-col 3 --city-col 4 --zip-col 5 input.csv   # by index
```

### Custom country aliases

The tool ships legitimate country-name variants (`USA`, `U.S.A.`, `U.S.`,
`America`, `UK`, `Ivory Coast`, etc.). For *dataset-specific* misspellings, pass a JSON map — it's merged on top
of the built-ins and overrides them:

```json
{ "United Sates": "US", "South Afria": "ZA" }
```

```sh
offline-csv-geocoder --aliases aliases.example.json input.csv
```

See [`aliases.example.json`](./aliases.example.json).

## Exit codes

| code | meaning |
|--:|---|
| `0` | Ran to completion. Rows the geocoder couldn’t place are a normal outcome: they’re listed under “Unmatched” and the exit code stays `0`. `--help` also exits `0`. |
| `1` | Partial: ran to completion, but some items failed. Reserved. The tool doesn’t currently emit it, because it stops at the first failure rather than skipping items. |
| `2` | Usage: an unknown flag, a flag missing its value, an unreadable or invalid `--aliases` file, an input path or glob that matches nothing (even alongside other inputs) or isn’t a file, or a `--*-col` option that names a column the input doesn’t have. The message and a usage hint go to stderr. |
| `3` | Could not complete: the GeoNames data is missing and can’t be downloaded, the data directory or an input/output file can’t be read or written, an input CSV is empty or has no Country or Zip/Postal column, or any other unexpected error. A one-line `error: …` goes to stderr. |

Output files written before a mid-run failure (for example, when the third of
five inputs has no Country column) are left in place.

## Upgrading from 1.0.0

See [CHANGELOG.md](./CHANGELOG.md) for the full list. What can break a script:

- **Exit codes.** 1.0.0 exited `1` on every error. 2.0.0 exits `2` for usage
  errors and `3` when it could not complete (see the table above).
- **Error text.** Usage errors print the message, then
  `Try offline-csv-geocoder --help for usage.` on its own line (1.0.0 appended
  “(try --help)” to the message). Other errors print one `error: …` line.
- **Stricter inputs.** A directory given as an input, or any input glob that
  matches nothing (even alongside other inputs), is now a usage error (`2`).
  An input with no Country or Zip/Postal column is exit `3`.
- **Postal codes with an unrecognized country.** A row whose Country cell is
  non-blank but unrecognized no longer takes a US ZIP (or a re-padded one) from
  its postal code; it is listed under “Unmatched”. Blank countries and close
  misspellings of “United States” behave as before.
- `require('offline-csv-geocoder')` no longer runs the CLI (in 1.0.0 it exited
  the host process).

On a clean run, stdout and the output files are otherwise the same as in 1.0.0.

## Known limits

- **Country-fallback matches are counted as geocoded and not flagged.** A row
  whose city isn’t found (`Springfeld`) lands on the country’s capital and
  counts toward `Geocoded X/Y`; nothing marks it as country-level.
- **The postal code beats city and state.** A re-padded or mistyped ZIP that
  points at another state (`OH, Cincinnati, 4029` → Maine) wins; there is no
  cross-check against the state.
- **A stray `"` inside an unquoted field** starts a quoted field, which can
  swallow the rest of the file into one cell. Quote such fields in the input.
- **`--output` is a file for one input and a directory for several**, even when
  a glob happens to match only one file, so `"data/*.csv" -o results/` fails if
  the glob matches a single file.
- **Inputs with the same basename overwrite each other** in an `--output`
  directory (`d1/data.csv d2/data.csv -o outdir`).
- **The tool’s own `*` glob matches dotfiles** such as `.DS_Store`; name the
  extension (`"dir/*.csv"`).
- **`--` and file names that start with `-` are not accepted** as inputs.
- **`--aliases` values are not validated.** A lowercase code (`"us"`) or a
  number never matches; those rows show up under “Unmatched”.
- **Offline first run.** With no network and no cached data, the run exits `3`
  with the bare fetch error; set `OFFLINE_CSV_GEOCODER_DATA_DIR` to a directory
  that holds the data.
- **The cache location** is `./data` inside the package whenever the package
  directory is writable (which includes Homebrew, nvm and npx installs), so
  those installs download the data again after a reinstall or upgrade.

## Data source & attribution

Uses the free [GeoNames](https://www.geonames.org/) dump, licensed
[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/). On first run it
downloads ~12MB (`cities500`, `admin1CodesASCII`, `countryInfo`, and the
`US`/`PR`/`VI`/`GU`/`AS`/`MP`/`CA` postal tables); after that everything runs
fully offline.

Downloaded data is cached in `./data` next to `index.js` when that directory
already exists or is writable (a local checkout, and most user-level global
installs), else in `$XDG_CACHE_HOME/offline-csv-geocoder` (default
`~/.cache/offline-csv-geocoder`). Override with `$OFFLINE_CSV_GEOCODER_DATA_DIR`. Delete the cache to force a
refresh.

**If you publish maps or data derived from these coordinates, you must
attribute GeoNames** (per CC-BY 4.0).

## Requirements

Node 18+ (built-in `fetch`) and `unzip` on `PATH` (preinstalled on macOS/Linux).

## License

MIT © Danniel T. Gaidula (source code; see [LICENSE](./LICENSE)). GeoNames data:
CC-BY 4.0 (see above).
