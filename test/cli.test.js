'use strict';

// Runs the CLI as a subprocess against a tiny fixture dataset built in a temp
// dir. Never downloads GeoNames and never touches the real data dir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INDEX = path.join(__dirname, '..', 'index.js');
// The commit that recorded the rename, i.e. the published 1.0.0 behaviour.
const BASELINE_COMMIT = '7fdeb5c';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-csv-geocoder-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const row = (n, fields) => { const r = Array(n).fill(''); for (const [i, v] of Object.entries(fields)) r[i] = v; return r.join('\t'); };

// Smallest dataset in the shapes index.js reads (see buildIndexes/ensureData).
function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(tmp, 'data-'));
  const w = (name, lines) => fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n');
  w('countryInfo.txt', [
    '# fixture',
    row(6, { 0: 'US', 4: 'United States', 5: 'Washington' }),
    row(6, { 0: 'CA', 4: 'Canada', 5: 'Ottawa' }),
  ]);
  w('admin1CodesASCII.txt', ['US.OH\tOhio\tOhio\t1', 'US.DC\tDistrict of Columbia\tDistrict of Columbia\t2', 'CA.08\tOntario\tOntario\t3']);
  const city = (name, lat, lon, cc, a1, pop) => row(15, { 1: name, 2: name, 4: lat, 5: lon, 8: cc, 10: a1, 14: pop });
  w('cities500.txt', [
    city('Cincinnati', '39.12714', '-84.51435', 'US', 'OH', 300000),
    city('Washington', '38.89511', '-77.03637', 'US', 'DC', 700000),
    city('Ottawa', '45.41117', '-75.69812', 'CA', '08', 900000),
  ]);
  const zip = (cc, code, lat, lon) => row(12, { 0: cc, 1: code, 9: lat, 10: lon });
  w('zip_US.txt', [zip('US', '45202', '39.1', '-84.5')]);
  w('zip_CA.txt', [zip('CA', 'K1A', '45.4', '-75.7')]);
  for (const cc of ['PR', 'VI', 'GU', 'AS', 'MP']) w(`zip_${cc}.txt`, []);
  return dir;
}

const DATA = makeDataDir();

function makeWorkDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'work-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function run(script, args, { cwd, data = DATA } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, OFFLINE_CSV_GEOCODER_DATA_DIR: data },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const cli = (args, opts) => run(INDEX, args, opts);

const GOOD_CSV = [
  'Name,Country,State,City,Zip',
  'A,United States,OH,Cincinnati,',
  'B,United States,,,45202',
  'C,Canada,ON,Ottawa,K1A 0B1',
  'D,Atlantis,,Nowhere,',
  'E,United States,,,',
  '',
].join('\n');

test('exit 0: clean run, with an ordinary geocode miss reported as a normal outcome', () => {
  const cwd = makeWorkDir({ 'in.csv': GOOD_CSV });
  const r = cli(['in.csv', '-o', 'out.csv'], { cwd });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Geocoded 4\/5 rows\./);
  assert.match(r.out, /Unmatched \(1\):/);
  assert.equal(r.err, '');
  assert.match(fs.readFileSync(path.join(cwd, 'out.csv'), 'utf8'), /^Name,Country,State,City,Zip,Lat,Lon\n/);
});

test('exit 0: --help, and --no-overwrite with nothing left to do', () => {
  const cwd = makeWorkDir({ 'in.csv': GOOD_CSV, 'out.csv': 'x' });
  assert.equal(cli(['--help'], { cwd }).code, 0);
  const r = cli(['in.csv', '-o', 'out.csv', '--no-overwrite'], { cwd });
  assert.equal(r.code, 0);
  assert.match(r.out, /Nothing to do\./);
});

test('clean-run stdout and output file are byte-identical to the rename commit (1.0.0 behaviour)', (t) => {
  const show = spawnSync('git', ['show', `${BASELINE_COMMIT}:index.js`], { cwd: __dirname, encoding: 'utf8' });
  if (show.status !== 0) return t.skip(`git history not available (${BASELINE_COMMIT})`);
  const baseline = path.join(makeWorkDir(), 'baseline-index.js');
  fs.writeFileSync(baseline, show.stdout);

  const second = GOOD_CSV.replace(/Cincinnati/g, 'Washington');
  const scenarios = [
    ['single input, explicit output', ['in.csv', '-o', 'out.csv']],
    ['default output name', ['in.csv']],
    ['multiple inputs into a directory', ['in.csv', 'in2.csv', '-o', 'outdir']],
    ['column override by index', ['in.csv', '-o', 'out.csv', '--country-col', '2', '--city-col', 'City']],
  ];
  for (const [label, args] of scenarios) {
    const a = makeWorkDir({ 'in.csv': GOOD_CSV, 'in2.csv': second });
    const b = makeWorkDir({ 'in.csv': GOOD_CSV, 'in2.csv': second });
    const ra = run(baseline, args, { cwd: a });
    const rb = cli(args, { cwd: b });
    assert.equal(ra.code, 0, `${label}: baseline ${ra.err}`);
    assert.equal(rb.code, 0, `${label}: ${rb.err}`);
    assert.equal(rb.out, ra.out, `${label}: stdout`);
    const outs = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => /out|latlon/.test(f) && fs.statSync(path.join(d, f)).isFile()).sort();
    assert.deepEqual(outs(b), outs(a), `${label}: file set`);
    for (const f of outs(a)) {
      assert.deepEqual(fs.readFileSync(path.join(b, f)), fs.readFileSync(path.join(a, f)), `${label}: ${f}`);
    }
  }
});

test('exit 2: usage errors, with a hint on stderr and nothing on stdout', async (t) => {
  const cwd = makeWorkDir({ 'in.csv': GOOD_CSV, 'aliases-bad.json': '{nope', 'aliases-array.json': '[]', 'nocols.csv': 'A,B\n1,2\n' });
  fs.mkdirSync(path.join(cwd, 'adir'));
  const cases = {
    'unknown flag': ['--bogus', 'in.csv'],
    '-o without a path': ['in.csv', '-o'],
    '--city-col without a value': ['in.csv', '--city-col'],
    '--aliases without a path': ['in.csv', '--aliases'],
    '--aliases file missing': ['in.csv', '--aliases', 'nope.json'],
    '--aliases not valid JSON': ['in.csv', '--aliases', 'aliases-bad.json'],
    '--aliases not an object': ['in.csv', '--aliases', 'aliases-array.json'],
    'no inputs at all': [],
    'glob matching nothing': ['nomatch-*.csv'],
    'input file missing': ['missing.csv'],
    'input path is a directory': ['adir'],
    '--country-col names no column': ['in.csv', '--country-col', 'Nation'],
    '--zip-col index out of range': ['in.csv', '--zip-col', '99'],
  };
  for (const [label, args] of Object.entries(cases)) {
    await t.test(label, () => {
      const r = cli(args, { cwd });
      assert.equal(r.code, 2, r.err);
      assert.match(r.err, /Try offline-csv-geocoder --help for usage\./);
      assert.doesNotMatch(r.out, /Wrote /);
    });
  }
});

test('exit 3: could not complete, with a one-line error: on stderr', async (t) => {
  const cwd = makeWorkDir({ 'in.csv': GOOD_CSV, 'empty.csv': '', 'nocols.csv': 'A,B\n1,2\n' });
  const expect3 = (r) => {
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, /^error: .+\n$/);
    assert.equal(r.err.trim().split('\n').length, 1);
  };

  await t.test('data dir path is a regular file (no download attempted)', () => {
    const notADir = path.join(cwd, 'not-a-dir');
    fs.writeFileSync(notADir, 'x');
    expect3(cli(['in.csv', '-o', 'out.csv'], { cwd, data: notADir }));
  });
  await t.test('dataset file unreadable', () => {
    const data = makeDataDir();
    fs.rmSync(path.join(data, 'cities500.txt'));
    fs.mkdirSync(path.join(data, 'cities500.txt'));
    expect3(cli(['in.csv', '-o', 'out.csv'], { cwd, data }));
  });
  await t.test('empty input CSV', () => {
    expect3(cli(['empty.csv', '-o', 'out.csv'], { cwd }));
  });
  await t.test('no Country or Zip column (a data problem, not usage)', () => {
    const r = cli(['nocols.csv', '-o', 'out.csv'], { cwd });
    expect3(r);
    assert.match(r.err, /No "Country" or Zip\/Postal column found/);
  });
  await t.test('output cannot be written', () => {
    expect3(cli(['in.csv', '-o', path.join('no-such-dir', 'out.csv')], { cwd }));
  });
});
