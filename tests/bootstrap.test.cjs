'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const BOOTSTRAP = path.resolve(__dirname, '..', 'bootstrap.ps1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function environment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key];
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra };
}

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd, env: environment(), encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.error?.message || result.stderr}`);
  return result.stdout.trim();
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function owned(root, target) {
  const absolute = path.resolve(target);
  const relative = path.relative(path.resolve(root), absolute);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Path is outside fixture: ${absolute}`);
  return absolute;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirasim-bootstrap-test-'));
  const source = path.join(root, '源仓库 with spaces');
  const cache = path.join(root, '用户 cache with spaces');
  const output = path.join(root, 'runtime-events.jsonl');
  fs.mkdirSync(source);
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Mirasim test']);
  git(source, ['config', 'user.email', 'tests@example.invalid']);
  git(source, ['config', 'core.autocrlf', 'false']);
  git(source, ['config', 'core.safecrlf', 'false']);
  t.after(() => {
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(actual).startsWith('mirasim-bootstrap-test-'));
    fs.rmSync(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function publish(version, mutate) {
    const script = `
[CmdletBinding()]
param([ValidateSet('install','status','restore','diagnose')][string]$Action='install',[switch]$NonInteractive)
$ErrorActionPreference='Stop'
$event=[ordered]@{version='${version}';action=$Action;nonInteractive=[bool]$NonInteractive}
[System.IO.File]::AppendAllText($env:MIRASIM_TEST_OUTPUT,(ConvertTo-Json $event -Compress)+[Environment]::NewLine,(New-Object System.Text.UTF8Encoding($false)))
if($env:MIRASIM_TEST_HOLD_MS){[System.Threading.Thread]::Sleep([int]$env:MIRASIM_TEST_HOLD_MS)}
if($env:MIRASIM_TEST_EXIT){exit [int]$env:MIRASIM_TEST_EXIT}
exit 0
`.trimStart();
    const files = {
      'runtime/run.ps1': Buffer.from('\ufeff' + script),
      'runtime/main.cjs': Buffer.from(`'use strict';\nmodule.exports = ${JSON.stringify(version)};\n`),
      'runtime/required-data.txt': Buffer.from(`release ${version}\n`),
    };
    for (const [name, bytes] of Object.entries(files)) {
      const file = owned(source, path.join(source, name));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    const release = { schemaVersion: 1, version, files: Object.entries(files).map(([name, bytes]) => ({ path: name, sha256: hash(bytes) })) };
    if (mutate) mutate(release, files);
    writeJson(path.join(source, 'release.json'), release);
    git(source, ['add', '--all']);
    git(source, ['commit', '-m', `Test release ${version}`]);
    for (const [name, bytes] of Object.entries(files)) {
      const stored = spawnSync('git', ['cat-file', 'blob', `HEAD:${name}`], { cwd: source, env: environment(), windowsHide: true });
      assert.equal(stored.status, 0);
      assert.ok(stored.stdout.equals(bytes), `Fixture Git blob differs from authored bytes: ${name}`);
    }
    return git(source, ['rev-parse', 'HEAD']);
  }

  function args(options = {}) {
    const result = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BOOTSTRAP,
      '-RepositoryUrl', source, '-Branch', 'main', '-CacheRoot', options.cache || cache,
      '-Action', options.action || 'install', '-NonInteractive'];
    if (options.offline) result.push('-Offline');
    return result;
  }

  function run(options = {}) {
    const result = spawnSync(POWERSHELL, args(options), {
      env: environment({ MIRASIM_TEST_OUTPUT: output, ...(options.env || {}) }),
      encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.ifError(result.error);
    return result;
  }

  function start(options = {}) {
    const child = spawn(POWERSHELL, args(options), {
      env: environment({ MIRASIM_TEST_OUTPUT: output, ...(options.env || {}) }),
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', status => resolve({ status, stdout, stderr }));
    });
    return { child, done };
  }

  const current = () => JSON.parse(fs.readFileSync(path.join(cache, 'current.json'), 'utf8').replace(/^\ufeff/, ''));
  const events = () => fs.existsSync(output) ? fs.readFileSync(output, 'utf8').replace(/^\ufeff/, '').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
  const snapshot = commit => path.join(cache, 'releases', commit);
  const hideSource = () => fs.renameSync(owned(root, source), owned(root, path.join(root, '暂存 source')));
  return { root, source, cache, output, publish, run, start, current, events, snapshot, hideSource };
}

function succeeded(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function rejected(result) {
  assert.notEqual(result.status, 0, `Unexpected success:\n${result.stdout}\n${result.stderr}`);
}

test('first launch, unchanged launch and next remote commit execute the corresponding immutable runtime', t => {
  const f = fixture(t);
  const first = f.publish('4.4.0');
  succeeded(f.run());
  assert.equal(f.current().commit, first);
  assert.equal(f.current().version, '4.4.0');
  assert.ok(fs.existsSync(path.join(f.snapshot(first), 'runtime', 'run.ps1')));
  succeeded(f.run({ action: 'status' }));
  assert.equal(f.current().commit, first);
  const second = f.publish('4.4.1');
  succeeded(f.run());
  assert.equal(f.current().commit, second);
  assert.equal(f.current().version, '4.4.1');
  assert.ok(fs.existsSync(path.join(f.snapshot(first), 'runtime', 'run.ps1')), 'The previous working snapshot remains available');
  assert.deepEqual(f.events(), [
    { version: '4.4.0', action: 'install', nonInteractive: true },
    { version: '4.4.0', action: 'status', nonInteractive: true },
    { version: '4.4.1', action: 'install', nonInteractive: true },
  ]);
});

test('network failure can use a verified previous release but cannot bootstrap an empty cache', t => {
  const f = fixture(t);
  const commit = f.publish('4.4.0');
  succeeded(f.run());
  f.hideSource();
  succeeded(f.run({ action: 'diagnose' }));
  assert.equal(f.current().commit, commit);
  assert.equal(f.events().at(-1).action, 'diagnose');
  const count = f.events().length;
  rejected(f.run({ cache: path.join(f.root, 'empty cache') }));
  assert.equal(f.events().length, count);
  assert.ok(!fs.existsSync(path.join(f.root, 'empty cache', 'current.json')));
});

test('explicit offline operation uses only the previously verified runtime', t => {
  const f = fixture(t);
  const first = f.publish('4.4.0');
  succeeded(f.run());
  f.publish('4.4.1');
  succeeded(f.run({ action: 'restore', offline: true }));
  assert.equal(f.current().commit, first);
  assert.equal(f.events().at(-1).version, '4.4.0');
  assert.equal(f.events().at(-1).action, 'restore');
});

test('a hash-mismatched update never runs or replaces current and a later valid update recovers', t => {
  const f = fixture(t);
  const first = f.publish('4.4.0');
  succeeded(f.run());
  const currentBytes = fs.readFileSync(path.join(f.cache, 'current.json'));
  const bad = f.publish('4.4.1', release => { release.files[0].sha256 = '0'.repeat(64); });
  rejected(f.run());
  assert.equal(f.events().length, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.cache, 'current.json')), currentBytes);
  assert.equal(f.current().commit, first);
  assert.ok(!fs.existsSync(f.snapshot(bad)), 'An invalid candidate cannot be promoted');
  const fixed = f.publish('4.4.2');
  succeeded(f.run());
  assert.equal(f.current().commit, fixed);
  assert.equal(f.events().at(-1).version, '4.4.2');
});

test('unsafe, duplicate and incomplete manifest paths cannot run candidate code', t => {
  const f = fixture(t);
  const first = f.publish('4.4.0');
  succeeded(f.run());
  const invalid = [
    release => { release.files.push({ path: 'runtime/../../escaped.ps1', sha256: 'a'.repeat(64) }); },
    release => { release.files.push({ ...release.files[0] }); },
    release => { release.files = release.files.filter(file => file.path !== 'runtime/main.cjs'); },
  ];
  for (let i = 0; i < invalid.length; i++) {
    f.publish(`4.5.${i}`, invalid[i]);
    rejected(f.run());
    assert.equal(f.current().commit, first);
    assert.equal(f.events().length, 1);
  }
  assert.ok(!fs.existsSync(path.join(f.root, 'escaped.ps1')));
});

test('a modified cached runtime is rejected even when offline was explicitly requested', t => {
  const f = fixture(t);
  const commit = f.publish('4.4.0');
  succeeded(f.run());
  fs.appendFileSync(owned(f.root, path.join(f.snapshot(commit), 'runtime', 'run.ps1')), '\n# external modification\n');
  rejected(f.run({ offline: true }));
  assert.equal(f.events().length, 1);
  assert.equal(f.current().commit, commit);
});

test('an interrupted bare-repository initialization without origin is repaired on the next launch', t => {
  const f = fixture(t);
  const commit = f.publish('4.4.0');
  fs.mkdirSync(f.cache, { recursive: true });
  git(f.cache, ['init', '--bare', path.join(f.cache, 'repository.git')]);
  succeeded(f.run());
  assert.equal(f.current().commit, commit);
  assert.deepEqual(f.events(), [{ version: '4.4.0', action: 'install', nonInteractive: true }]);
});

test('a bare repository with existing refs and no origin is not silently repurposed', t => {
  const f = fixture(t);
  const commit = f.publish('4.4.0');
  fs.mkdirSync(f.cache, { recursive: true });
  const bare = path.join(f.cache, 'repository.git');
  git(f.cache, ['init', '--bare', bare]);
  git(f.cache, [`--git-dir=${bare}`, 'fetch', f.source, 'main:refs/heads/existing']);
  const refs = git(f.cache, [`--git-dir=${bare}`, 'show-ref']);
  assert.ok(refs.includes(commit));
  rejected(f.run());
  assert.equal(f.events().length, 0);
  assert.ok(!fs.existsSync(path.join(f.cache, 'current.json')));
  assert.equal(git(f.cache, [`--git-dir=${bare}`, 'show-ref']), refs);
  assert.equal(git(f.cache, [`--git-dir=${bare}`, 'remote']), '');
});

test('runtime actions and nonzero exit codes pass through and do not leave a stale lock', t => {
  const f = fixture(t);
  f.publish('4.4.0');
  const failed = f.run({ action: 'status', env: { MIRASIM_TEST_EXIT: '3' } });
  assert.equal(failed.status, 3, `${failed.stdout}\n${failed.stderr}`);
  succeeded(f.run({ action: 'restore' }));
  assert.deepEqual(f.events().map(e => e.action), ['status', 'restore']);
});

test('concurrent launches cannot run a second updater or installer while the first runtime holds the lock', async t => {
  const f = fixture(t);
  f.publish('4.4.0');
  const running = f.start({ env: { MIRASIM_TEST_HOLD_MS: '6500' } });
  try {
    const deadline = Date.now() + 30000;
    while (!f.events().length && Date.now() < deadline) await wait(50);
    assert.equal(f.events().length, 1, 'First runtime must have started before checking the held lock');
    const second = f.run({ action: 'restore' });
    rejected(second);
    assert.equal(f.events().length, 1, 'Second runtime was never started');
  } finally {
    succeeded(await running.done);
  }
  succeeded(f.run({ action: 'diagnose' }));
  assert.deepEqual(f.events().map(e => e.action), ['install', 'diagnose']);
});
