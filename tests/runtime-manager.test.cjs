'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const RUNTIME = path.resolve(__dirname, '../runtime');
const { parseAsar } = require('../runtime/asar.cjs');
const { KIT_VERSION } = require('../runtime/cache-manager.cjs');

const VERSION = '0.0.774';
const FEATURES = ['codex-speed', 'claude-ultracode', 'claude-fast'];
const INPUT = 'renderer/assets/input.js';
const CATALOG = 'renderer/assets/state-catalog.js';
const UNRELATED = 'renderer/assets/unrelated.js';
const INTEGRITY = 'renderer/integrity.json';
const MARKER = '/* mirasim-speed-picker:multi-asset-test */';
const OLD_MARKER = '/* mirasim-speed-picker:legacy-test */';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function snapshot(root) {
  if (!fs.existsSync(root)) return {};
  const result = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file).replaceAll('\\', '/')] = sha(fs.readFileSync(file));
    }
  }
  walk(root);
  return result;
}

function loadInstrumented(name, control) {
  const instrumentedFs = {
    ...fs,
    renameSync(from, to) {
      if (control.beforeRename) control.beforeRename(from, to);
      return fs.renameSync(from, to);
    },
  };
  const loaded = { exports: {} };
  const filename = path.join(RUNTIME, name);
  const runtimeRequire = createRequire(filename);
  new Function('require', 'module', 'exports', '__dirname', '__filename', fs.readFileSync(filename, 'utf8'))(
    dependency => dependency === 'node:fs' ? instrumentedFs : runtimeRequire(dependency),
    loaded, loaded.exports, RUNTIME, filename,
  );
  return loaded.exports;
}

function sandbox(t, prefix = '') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mirasim-v42-multi-'));
  const home = path.join(temporary, 'user home');
  const kitDir = path.join(temporary, 'tool kit');
  write(path.join(kitDir, 'speed-picker.template.js'), '/* fixture template */');
  t.after(() => {
    const actual = fs.realpathSync(temporary);
    assert.equal(path.dirname(actual).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(actual).startsWith('mirasim-v42-multi-'));
    fs.rmSync(actual, { recursive: true, force: true });
  });
  const control = { rejectPatch: false, badSyntax: false, beforeRename: null, patchInputs: [] };
  const frontPaths = [prefix + INPUT, prefix + CATALOG];
  function check(source) {
    assert.ok(!source.includes('mirasim-speed-picker:'), 'adapter must receive pristine source');
  }
  function reject() {
    if (control.rejectPatch) {
      const error = new Error('fixture incompatible');
      error.code = 'FIXTURE_INCOMPATIBLE';
      throw error;
    }
  }
  const compat = {
    detectBackend(source) { check(source); return { evidence: ['fixture backend'] }; },
    detectFrontendAssets(assets) {
      assert.ok(assets instanceof Map);
      for (const relative of frontPaths) check(assets.get(relative));
      return { paths: frontPaths, evidence: ['fixture split frontend'] };
    },
    patchBackend(source) {
      reject(); check(source);
      control.patchInputs.push(['server-main.cjs', source]);
      return { source: source + '\n' + MARKER, changes: ['backend'], evidence: [] };
    },
    patchFrontendAssets(assets, options) {
      reject(); assert.equal(options.speedTemplate, '/* fixture template */');
      const files = new Map();
      for (const relative of frontPaths) {
        const source = assets.get(relative);
        check(source); control.patchInputs.push([relative, source]);
        files.set(relative, source + '\n' + MARKER);
      }
      return { files: control.frontFiles || files, changes: ['input', 'catalog'], evidence: [] };
    },
  };
  const options = {
    home, kitDir, compat,
    syntaxCheck() {
      if (control.badSyntax) {
        const error = new Error('fixture candidate syntax rejected');
        error.code = 'SYNTAX_CHECK_FAILED';
        throw error;
      }
    },
  };
  return { temporary, home, kitDir, control, options };
}

function originals() {
  const files = new Map([
    ['server-main.cjs', Buffer.from('/* original backend */\n')],
    [INPUT, Buffer.from('/* data-route-pick hub.selectEffort */\n')],
    [CATALOG, Buffer.from('/* case"catalog" */\n')],
    [UNRELATED, Buffer.from('export const untouched = true;\n')],
  ]);
  const integrity = { version: 1, files: {} };
  for (const relative of [INPUT, CATALOG, UNRELATED]) {
    const bytes = files.get(relative);
    integrity.files[relative.slice('renderer/'.length)] = { size: bytes.length, sha256: sha(bytes), fixture: 'preserved' };
  }
  files.set(INTEGRITY, json(integrity));
  return files;
}

function cacheFixture(t) {
  const f = sandbox(t);
  const app = path.join(f.home, '.mirasim', 'app', VERSION);
  const original = originals();
  for (const [relative, bytes] of original) write(path.join(app, relative), bytes);
  write(path.join(app, 'payload.json'), json({ version: VERSION, minShellAbi: 194, maxShellAbi: 194 }));
  const { createManager } = loadInstrumented('cache-manager.cjs', f.control);
  const manager = createManager(f.options);
  function receipts() {
    const builds = path.join(manager.backupRoot, VERSION, 'builds');
    if (!fs.existsSync(builds)) return [];
    return fs.readdirSync(builds).map(name => {
      const directory = path.join(builds, name), file = path.join(directory, 'installation.json');
      return { directory, file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
    });
  }
  function legacy(generation = 1) {
    const directory = generation === 1 ? path.join(manager.backupRoot, VERSION)
      : path.join(manager.backupRoot, VERSION, 'builds', 'a'.repeat(24));
    const after = new Map(original);
    for (const relative of ['server-main.cjs', INPUT]) {
      after.set(relative, Buffer.concat([original.get(relative), Buffer.from('\n' + OLD_MARKER)]));
    }
    const integrity = JSON.parse(original.get(INTEGRITY));
    integrity.files[INPUT.slice('renderer/'.length)] = { size: after.get(INPUT).length, sha256: sha(after.get(INPUT)) };
    after.set(INTEGRITY, json(integrity));
    const files = ['server-main.cjs', INPUT, INTEGRITY].map(relative => ({
      relative, beforeSha256: sha(original.get(relative)), afterSha256: sha(after.get(relative)),
    }));
    const data = { version: VERSION, formatVersion: generation, kitVersion: `${generation}.0.0`,
      features: ['codex-speed'], installedAt: '2026-01-01T00:00:00.000Z', files };
    for (const entry of files) {
      write(path.join(directory, 'original', entry.relative), original.get(entry.relative));
      write(path.join(app, entry.relative), after.get(entry.relative));
    }
    const file = path.join(directory, 'installation.json');
    write(file, json(data));
    return { directory, file, data, after, bytes: fs.readFileSync(file) };
  }
  return { ...f, app, original, manager, receipts, legacy, snapshot: () => snapshot(app) };
}

function assertPatchedFront(root, prefix = '') {
  const read = relative => typeof root === 'string' ? fs.readFileSync(path.join(root, relative)) : root.readFile(prefix + relative);
  const integrity = JSON.parse(read(INTEGRITY));
  for (const relative of [INPUT, CATALOG]) {
    const bytes = read(relative), entry = integrity.files[relative.slice('renderer/'.length)];
    assert.ok(bytes.toString().endsWith(MARKER), `${relative} has the new control patch`);
    assert.equal(entry.sha256, sha(bytes));
    assert.equal(entry.size, bytes.length);
    assert.equal(entry.fixture, 'preserved');
  }
}

test('cache: installs both small split assets, records four originals, and restores exact bytes', t => {
  const f = cacheFixture(t), before = f.snapshot();
  assert.equal(f.manager.inspect(VERSION).state, 'compatible');
  assert.equal(f.manager.install(VERSION).state, 'installed');
  assertPatchedFront(f.app);
  assert.deepEqual(fs.readFileSync(path.join(f.app, UNRELATED)), f.original.get(UNRELATED));
  const receipt = f.receipts()[0];
  assert.equal(receipt.data.formatVersion, 5);
  assert.deepEqual(receipt.data.features, FEATURES);
  assert.deepEqual(receipt.data.files.map(entry => entry.relative), ['server-main.cjs', INPUT, CATALOG, INTEGRITY]);
  for (const entry of receipt.data.files) {
    assert.equal(entry.beforeSha256, entry.inputSha256);
    assert.deepEqual(fs.readFileSync(path.join(receipt.directory, 'original', entry.relative)), f.original.get(entry.relative));
  }
  const installed = f.snapshot();
  assert.equal(f.manager.install(VERSION).state, 'already-installed');
  assert.deepEqual(f.snapshot(), installed);
  assert.equal(f.manager.restore(VERSION).state, 'restored');
  assert.deepEqual(f.snapshot(), before);
});

test('cache: failure writing the second frontend rolls back earlier writes and remains repairable', t => {
  const f = cacheFixture(t), before = f.snapshot();
  let refused = false, recoveryReady = false;
  f.control.beforeRename = (_from, to) => {
    if (to !== path.join(f.app, CATALOG) || refused) return;
    recoveryReady = f.receipts()[0].data.state === 'installing';
    assert.ok(fs.readFileSync(path.join(f.app, INPUT), 'utf8').includes(MARKER));
    assert.ok(fs.readFileSync(path.join(f.app, 'server-main.cjs'), 'utf8').includes(MARKER));
    refused = true;
    const error = new Error('fixture second frontend locked'); error.code = 'EACCES'; throw error;
  };
  assert.throws(() => f.manager.install(VERSION), error => error.code === 'EACCES');
  assert.ok(refused && recoveryReady);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.manager.status(VERSION).state, 'restored');
  assert.equal(f.manager.install(VERSION).state, 'installed');
  assertPatchedFront(f.app);
});

test('cache: recognizes and repairs a mixed interrupted four-file install', t => {
  const f = cacheFixture(t), before = f.snapshot();
  f.manager.install(VERSION);
  for (const relative of [CATALOG, INTEGRITY]) write(path.join(f.app, relative), f.original.get(relative));
  assert.equal(f.manager.status(VERSION).state, 'interrupted');
  assert.equal(f.manager.inspect(VERSION).state, 'interrupted');
  assert.equal(f.manager.install(VERSION).state, 'installed');
  assertPatchedFront(f.app);
  f.manager.restore(VERSION);
  assert.deepEqual(f.snapshot(), before);
});

test('cache: incompatible or invalid retry leaves interrupted files and receipt untouched', t => {
  const f = cacheFixture(t);
  f.manager.install(VERSION);
  for (const relative of [CATALOG, INTEGRITY]) write(path.join(f.app, relative), f.original.get(relative));
  const before = f.snapshot(), backups = snapshot(f.manager.backupRoot);
  for (const flag of ['rejectPatch', 'badSyntax']) {
    f.control[flag] = true;
    assert.throws(() => f.manager.install(VERSION), error => ['FIXTURE_INCOMPATIBLE', 'SYNTAX_CHECK_FAILED'].includes(error.code));
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(snapshot(f.manager.backupRoot), backups);
    f.control[flag] = false;
  }
});

for (const generation of [1, 3]) {
  test(`cache: upgrades a generation ${generation} three-file receipt and preserves original backups`, t => {
    const f = cacheFixture(t), pristine = f.snapshot(), legacy = f.legacy(generation);
    assert.equal(f.manager.inspect(VERSION).state, 'upgradeable');
    assert.equal(f.manager.install(VERSION).state, 'installed');
    assertPatchedFront(f.app);
    const receipt = f.receipts().find(entry => entry.data.kitVersion === KIT_VERSION);
    assert.equal(receipt.data.files.length, 4);
    assert.deepEqual(fs.readFileSync(legacy.file), legacy.bytes);
    for (const entry of legacy.data.files) assert.deepEqual(
      fs.readFileSync(path.join(legacy.directory, 'original', entry.relative)), f.original.get(entry.relative));
    for (const entry of receipt.data.files) {
      assert.deepEqual(fs.readFileSync(path.join(receipt.directory, 'original', entry.relative)), f.original.get(entry.relative));
      assert.equal(entry.inputSha256, sha(legacy.after.get(entry.relative)));
    }
    f.manager.restore(VERSION);
    assert.deepEqual(f.snapshot(), pristine);
  });
}

test('cache: failed upgrade restores previous working controls rather than pristine files', t => {
  const f = cacheFixture(t), legacy = f.legacy(), previous = f.snapshot();
  let refused = false;
  f.control.beforeRename = (_from, to) => {
    if (to !== path.join(f.app, CATALOG) || refused) return;
    refused = true; throw new Error('fixture failed upgrade');
  };
  assert.throws(() => f.manager.install(VERSION), /fixture failed upgrade/);
  assert.deepEqual(f.snapshot(), previous);
  assert.deepEqual(fs.readFileSync(legacy.file), legacy.bytes);
  assert.equal(f.manager.install(VERSION).state, 'installed');
  assertPatchedFront(f.app);
});

test('cache: compatibility and syntax rejection keep an older installation untouched', t => {
  const f = cacheFixture(t); f.legacy();
  const previous = f.snapshot(), backups = snapshot(f.manager.backupRoot);
  for (const flag of ['rejectPatch', 'badSyntax']) {
    f.control[flag] = true;
    assert.throws(() => f.manager.install(VERSION));
    assert.deepEqual(f.snapshot(), previous);
    assert.deepEqual(snapshot(f.manager.backupRoot), backups);
    f.control[flag] = false;
  }
});

test('cache: an externally changed newly added catalog refuses legacy upgrade without any writes', t => {
  const f = cacheFixture(t); f.legacy();
  fs.appendFileSync(path.join(f.app, CATALOG), '\n/* external catalog edit */');
  const current = f.snapshot(), backups = snapshot(f.manager.backupRoot);
  assert.throws(() => f.manager.install(VERSION), error => error.code === 'INTEGRITY_MISMATCH');
  assert.deepEqual(f.snapshot(), current);
  assert.deepEqual(snapshot(f.manager.backupRoot), backups);
});

test('cache: a write failure during interrupted retry restores the exact mixed input state', t => {
  const f = cacheFixture(t); f.manager.install(VERSION);
  for (const relative of ['server-main.cjs', CATALOG]) write(path.join(f.app, relative), f.original.get(relative));
  const mixed = f.snapshot();
  assert.equal(f.manager.status(VERSION).state, 'interrupted');
  let refused = false;
  f.control.beforeRename = (_from, to) => {
    if (to !== path.join(f.app, CATALOG) || refused) return;
    refused = true; throw new Error('fixture interrupted retry failure');
  };
  assert.throws(() => f.manager.install(VERSION), /fixture interrupted retry failure/);
  assert.ok(refused);
  assert.deepEqual(f.snapshot(), mixed);
  assert.equal(f.manager.status(VERSION).state, 'interrupted');
  assert.equal(f.manager.install(VERSION).state, 'installed');
});

test('cache: restoring a retired frontend patch reports restored when its before and after hashes match', t => {
  const f = cacheFixture(t), pristine = f.snapshot(); f.legacy();
  f.control.frontFiles = new Map([[CATALOG, f.original.get(CATALOG).toString() + '\n' + MARKER]]);
  assert.equal(f.manager.install(VERSION).state, 'installed');
  const receipt = f.receipts().find(entry => entry.data.kitVersion === KIT_VERSION);
  const retired = receipt.data.files.find(entry => entry.relative === INPUT);
  assert.equal(retired.beforeSha256, retired.afterSha256);
  assert.equal(f.manager.restore(VERSION).state, 'restored');
  assert.deepEqual(f.snapshot(), pristine);
  assert.equal(f.manager.status(VERSION).state, 'restored');
  assert.equal(f.manager.inspect(VERSION).state, 'restored-compatible');
});

test('cache: an oversized union of old and new frontend paths is rejected before creating an unreadable receipt', t => {
  const f = cacheFixture(t), integrity = JSON.parse(f.original.get(INTEGRITY));
  const replacements = new Map([[CATALOG, f.original.get(CATALOG).toString() + '\n' + MARKER]]);
  for (let index = 0; index < 15; index++) {
    const relative = `renderer/assets/additional-${index}.js`, bytes = Buffer.from(`/* extra ${index} */`);
    write(path.join(f.app, relative), bytes);
    f.original.set(relative, bytes);
    integrity.files[relative.slice('renderer/'.length)] = { size: bytes.length, sha256: sha(bytes) };
    replacements.set(relative, bytes.toString() + '\n' + MARKER);
  }
  f.original.set(INTEGRITY, json(integrity));
  write(path.join(f.app, INTEGRITY), f.original.get(INTEGRITY));
  f.legacy();
  f.control.frontFiles = replacements;
  const current = f.snapshot(), backups = snapshot(f.manager.backupRoot);
  assert.equal(replacements.size, 16);
  assert.throws(() => f.manager.install(VERSION), error => error.code === 'INVALID_FRONTEND_PLAN');
  assert.deepEqual(f.snapshot(), current);
  assert.deepEqual(snapshot(f.manager.backupRoot), backups);
  assert.equal(f.manager.status(VERSION).state, 'upgradeable');
});

test('cache: hostile paths, duplicate targets, and excessive receipt entries refuse all writes', t => {
  const f = cacheFixture(t); f.manager.install(VERSION);
  const receipt = f.receipts()[0], before = f.snapshot();
  const mutations = [
    data => { data.files[1].relative = '../outside.js'; },
    data => { data.files[1].relative = 'renderer/assets/../../outside.js'; },
    data => { data.files[1].relative = 'renderer\\assets\\input.js'; },
    data => { data.files[2].relative = data.files[1].relative; },
    data => { while (data.files.length < 19) data.files.push({ ...data.files[1] }); },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(receipt.data); mutate(invalid); write(receipt.file, json(invalid));
    assert.throws(() => f.manager.restore(VERSION), error => error.code === 'INVALID_RECEIPT');
    assert.throws(() => f.manager.install(VERSION), error => error.code === 'INVALID_RECEIPT');
    assert.deepEqual(f.snapshot(), before);
  }
});

test('cache: a damaged original catalog integrity entry refuses a fresh install before backups', t => {
  const f = cacheFixture(t), integrity = JSON.parse(f.original.get(INTEGRITY));
  integrity.files[CATALOG.slice('renderer/'.length)].sha256 = '0'.repeat(64);
  write(path.join(f.app, INTEGRITY), json(integrity));
  const before = f.snapshot();
  assert.throws(() => f.manager.install(VERSION), error => error.code === 'INTEGRITY_MISMATCH');
  assert.deepEqual(f.snapshot(), before);
  assert.equal(fs.existsSync(f.manager.backupRoot), false);
});

test('cache: a damaged late backup refuses restore and interrupted repair before target writes', t => {
  const f = cacheFixture(t); f.manager.install(VERSION);
  const receipt = f.receipts()[0];
  fs.appendFileSync(path.join(receipt.directory, 'original', CATALOG), 'damage');
  const installed = f.snapshot();
  assert.throws(() => f.manager.restore(VERSION), error => error.code === 'BACKUP_DAMAGED');
  assert.deepEqual(f.snapshot(), installed);
  write(path.join(f.app, INTEGRITY), f.original.get(INTEGRITY));
  const interrupted = f.snapshot();
  assert.equal(f.manager.status(VERSION).state, 'interrupted');
  assert.throws(() => f.manager.install(VERSION), error => error.code === 'BACKUP_DAMAGED');
  assert.deepEqual(f.snapshot(), interrupted);
});

test('cache: unknown external changes refuse restoration and patch stacking', t => {
  const f = cacheFixture(t); f.manager.install(VERSION);
  fs.appendFileSync(path.join(f.app, CATALOG), '\n/* external edit */');
  const changed = f.snapshot();
  assert.throws(() => f.manager.restore(VERSION), error => error.code === 'RESTORE_REFUSED');
  assert.throws(() => f.manager.install(VERSION), error => error.code === 'UNRECOGNIZED_PATCH');
  assert.deepEqual(f.snapshot(), changed);
});

test('cache: an empty or unknown frontend plan cannot create backups or write targets', t => {
  const f = cacheFixture(t), before = f.snapshot();
  for (const files of [new Map(), new Map([['renderer/assets/missing.js', '/* fixture */']]), new Map([['server-main.cjs', '/* fixture */']])]) {
    f.control.frontFiles = files;
    assert.throws(() => f.manager.install(VERSION), error => error.code === 'INVALID_FRONTEND_PLAN');
    assert.deepEqual(f.snapshot(), before);
    assert.equal(fs.existsSync(f.manager.backupRoot), false);
  }
});

function makeAsar(files) {
  const header = { files: {} }, chunks = [];
  let offset = 0;
  for (const [name, value] of files) {
    const bytes = Buffer.from(value), segments = name.split('/');
    let parent = header.files;
    for (const segment of segments.slice(0, -1)) {
      parent[segment] ||= { files: {} }; parent = parent[segment].files;
    }
    parent[segments.at(-1)] = { size: bytes.length, offset: String(offset), integrity: {
      algorithm: 'SHA256', hash: sha(bytes), blockSize: 4194304, blocks: bytes.length ? [sha(bytes)] : [],
    } };
    chunks.push(bytes); offset += bytes.length;
  }
  const bytes = Buffer.from(JSON.stringify(header)), payloadSize = Math.ceil((4 + bytes.length) / 4) * 4;
  const prefix = Buffer.alloc(12 + payloadSize);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(payloadSize + 4, 4);
  prefix.writeUInt32LE(payloadSize, 8); prefix.writeUInt32LE(bytes.length, 12); bytes.copy(prefix, 16);
  return Buffer.concat([prefix, ...chunks]);
}

function bundledFixture(t) {
  const f = sandbox(t, 'dist/'), original = originals();
  const resources = path.join(f.temporary, 'program', 'resources');
  const entries = new Map([
    ['package.json', json({ name: 'fixture', version: VERSION, main: 'dist/main.cjs' })],
    ['dist/main.cjs', 'const fixture={"abi":194,"surface":"test"};'],
    ['dist/renderer/assets/keep.txt', 'unrelated archive content'],
    ...[...original].filter(([relative]) => relative !== 'server-main.cjs').map(([relative, bytes]) => ['dist/' + relative, bytes]),
  ]);
  const archive = makeAsar(entries);
  write(path.join(resources, 'app.asar'), archive);
  write(path.join(resources, 'server-main.cjs'), original.get('server-main.cjs'));
  const { createBundledManager } = loadInstrumented('bundled-manager.cjs', f.control);
  const manager = createBundledManager({ ...f.options, resourcesDir: resources,
    fuseCheck: () => ({ embeddedAsarIntegrityValidation: false }) });
  function receipt() {
    const builds = path.join(manager.backupRoot, VERSION, 'builds');
    const directory = path.join(builds, fs.readdirSync(builds)[0]), file = path.join(directory, 'installation.json');
    return { directory, file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  return { ...f, resources, original, entries, archive, manager, receipt, snapshot: () => snapshot(resources) };
}

test('bundled: updates both split assets and both integrity layers; restores the exact original ASAR', t => {
  const f = bundledFixture(t), before = f.snapshot();
  assert.equal(f.manager.metadata().abi, 194);
  assert.equal(f.manager.inspect().state, 'compatible');
  assert.equal(f.manager.install().state, 'installed');
  const archive = parseAsar(fs.readFileSync(path.join(f.resources, 'app.asar')));
  assertPatchedFront(archive, 'dist/');
  for (const relative of [INPUT, CATALOG, INTEGRITY]) {
    const name = 'dist/' + relative, bytes = archive.readFile(name);
    assert.equal(archive.getEntry(name).metadata.integrity.hash, sha(bytes));
  }
  for (const name of ['package.json', 'dist/main.cjs', 'dist/' + UNRELATED, 'dist/renderer/assets/keep.txt']) {
    assert.deepEqual(archive.readFile(name), Buffer.from(f.entries.get(name)));
  }
  const receipt = f.receipt();
  assert.equal(receipt.data.files.length, 2);
  assert.deepEqual(receipt.data.renderers, ['dist/' + INPUT, 'dist/' + CATALOG]);
  assert.deepEqual(fs.readFileSync(path.join(receipt.directory, 'original', 'app.asar')), f.archive);
  const installed = f.snapshot();
  assert.equal(f.manager.install().state, 'already-installed');
  assert.deepEqual(f.snapshot(), installed);
  assert.equal(f.manager.restore().state, 'restored');
  assert.deepEqual(f.snapshot(), before);
});

test('bundled: locked ASAR rolls the backend back and preserves a usable recovery receipt', t => {
  const f = bundledFixture(t), before = f.snapshot();
  let refused = false, recoveryReady = false;
  f.control.beforeRename = (_from, to) => {
    if (to !== path.join(f.resources, 'app.asar') || refused) return;
    recoveryReady = f.receipt().data.state === 'installing';
    assert.ok(fs.readFileSync(path.join(f.resources, 'server-main.cjs'), 'utf8').includes(MARKER));
    refused = true;
    const error = new Error('fixture ASAR locked'); error.code = 'EPERM'; throw error;
  };
  assert.throws(() => f.manager.install(), error => error.code === 'BUNDLED_FILE_IN_USE');
  assert.ok(refused && recoveryReady);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.manager.status().state, 'restored');
  assert.equal(f.manager.install().state, 'installed');
});

test('bundled: interrupted retry validates both assets before replacing the older mixed state', t => {
  const f = bundledFixture(t), pristine = f.snapshot();
  f.manager.install();
  write(path.join(f.resources, 'app.asar'), f.archive);
  assert.equal(f.manager.status().state, 'interrupted');
  const interrupted = f.snapshot(), backups = snapshot(f.manager.backupRoot);
  for (const flag of ['rejectPatch', 'badSyntax']) {
    f.control[flag] = true;
    assert.throws(() => f.manager.install());
    assert.deepEqual(f.snapshot(), interrupted);
    assert.deepEqual(snapshot(f.manager.backupRoot), backups);
    f.control[flag] = false;
  }
  assert.equal(f.manager.install().state, 'installed');
  assertPatchedFront(parseAsar(fs.readFileSync(path.join(f.resources, 'app.asar'))), 'dist/');
  f.manager.restore();
  assert.deepEqual(f.snapshot(), pristine);
});
