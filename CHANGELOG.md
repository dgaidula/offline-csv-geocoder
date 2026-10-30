# Changelog

## 2.0.0 (unreleased)

Breaking changes from 1.0.0:

- Exit codes: every error was exit `1`. Usage errors now exit `2` and print
  `Try offline-csv-geocoder --help for usage.` on a second line (the
  “(try --help)” suffix is gone); anything that stops a run exits `3` with a
  one-line `error: …` on stderr. Exit `1` is reserved.
- A directory given as an input is a usage error (`2`).
- An input glob that matches nothing is a usage error (`2`), even alongside
  other inputs (1.0.0 dropped it silently).
- An input with no Country or Zip/Postal column exits `3`.
- A non-blank Country cell that isn’t recognized no longer takes a US ZIP from
  the postal code (1.0.0 placed `Deutschland, 10115` in Manhattan); the row is
  listed under “Unmatched”. Close misspellings of “United States” (at most two
  edits) still count as the US.
- A 3–4-digit postal code is re-padded to a US ZIP only when the country is the
  United States, not when it is blank.

Other changes:

- `U.S.A.`, `U.S.`, `America` and `United States, America` are built-in
  aliases for the United States (in 1.0.0 they were unrecognized, which the
  ZIP path happened to hide).
- The Unmatched list ends with `... and N more distinct rows` when more than
  20 distinct rows are unmatched.
- `require('offline-csv-geocoder')` no longer runs the CLI.
- Tests for the README’s data-handling claims (BOM, re-run guard, ZIP
  re-padding, rural Canadian FSAs, province codes, output quoting).

## 1.0.0

First release.
