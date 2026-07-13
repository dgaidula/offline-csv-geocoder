# csv-geocoder

**Offline** forward geocoder (no API key, no rate limits, **zero npm
dependencies**) that appends `Lat` and `Lon` columns to a CSV using the `City`,
`State`, and `Country` columns — with **US ZIP and Canadian postal-code
precision** when a Zip/Postal column is present. One file.

It fills a specific gap: the offline geocoders on npm are almost all *reverse*
(coordinates → place), and the CSV batch tools are online-only and need an API
key. This does *forward*, offline, CSV-native geocoding with postal precision.

```sh
npx csv-geocoder input.csv                        # writes input_with_latlon.csv
npx csv-geocoder input.csv -o out.csv             # explicit output file
npx csv-geocoder "data/*.csv" -o results/         # glob in, output directory
npx csv-geocoder --help
```

Or install it: `npm i -g csv-geocoder`, then run `csv-geocoder ...`.

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
summary.

### Real-world-data handling baked in

- **US territories** (Puerto Rico, US Virgin Islands, Guam, American Samoa,
  Northern Marianas) are labeled "United States" in most data but live in
  separate GeoNames tables — they're merged in, so `San Juan, PR 00921` lands in
  the Caribbean, not San Juan, Texas.
- **Rural Canadian FSAs** (`x0x`) cover whole regions, so for those an exact
  city+province match is preferred and the FSA centroid is the fallback. This
  also corrects same-named towns across provinces (Lethbridge AB vs NL).
- **Excel-stripped leading zeros** — a ZIP that arrived as `4029` is re-padded to
  `04029`.
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
csv-geocoder --country-col Nation --city-col Municipality --zip-col "Post Code" input.csv
csv-geocoder --country-col 2 --state-col 3 --city-col 4 --zip-col 5 input.csv   # by index
```

### Custom country aliases

The tool ships legitimate country-name variants (`USA`, `UK`, `Ivory Coast`,
etc.). For *dataset-specific* misspellings, pass a JSON map — it's merged on top
of the built-ins and overrides them:

```json
{ "United Sates": "US", "South Afria": "ZA" }
```

```sh
csv-geocoder --aliases aliases.example.json input.csv
```

See [`aliases.example.json`](./aliases.example.json).

## Data source & attribution

Uses the free [GeoNames](https://www.geonames.org/) dump, licensed
[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/). On first run it
downloads ~12MB (`cities500`, `admin1CodesASCII`, `countryInfo`, and the
`US`/`PR`/`VI`/`GU`/`AS`/`MP`/`CA` postal tables); after that everything runs
fully offline.

Downloaded data is cached in `./data` for a local checkout, or in
`$XDG_CACHE_HOME/addlatloncsv` (default `~/.cache/addlatloncsv`) for a global
install. Override with `$ADDLATLON_DATA_DIR`. Delete the cache to force a
refresh.

**If you publish maps or data derived from these coordinates, you must
attribute GeoNames** (per CC-BY 4.0).

## Requirements

Node 18+ (built-in `fetch`) and `unzip` on `PATH` (preinstalled on macOS/Linux).

## License

Source code: [MIT](./LICENSE). GeoNames data: CC-BY 4.0 (see above).
