'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mirasim-runtime-diagnostics-'));
  const kitDir = path.join(temporary, 'runtime folder');
  fs.mkdirSync(kitDir);
  fs.copyFileSync(path.resolve(__dirname, '../runtime/main.cjs'), path.join(kitDir, 'main.cjs'));
  fs.writeFileSync(path.join(kitDir, 'manager.cjs'), `
const fs=require('node:fs'),path=require('node:path');
exports.KIT_VERSION='test-runtime';
exports.atomic=(file,content)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content)};
exports.createManager=()=>({kitDir:__dirname,discover:()=>({targets:['fixture-version']}),diagnose:()=>({version:'fixture-version',state:'compatible'})});
`);
  t.after(() => {
    const actual = fs.realpathSync(temporary);
    assert.equal(path.dirname(actual).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(actual).startsWith('mirasim-runtime-diagnostics-'));
    fs.rmSync(actual, { recursive: true, force: true });
  });
  return { temporary, kitDir };
}

function run(kitDir, diagnosticDirectory) {
  const env = { ...process.env };
  delete env.MIRASIM_CONTROLS_DIAGNOSTICS;
  if (diagnosticDirectory !== undefined) env.MIRASIM_CONTROLS_DIAGNOSTICS = diagnosticDirectory;
  const result = spawnSync(process.execPath, [path.join(kitDir, 'main.cjs'), 'diagnose', '--non-interactive'], {
    env, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function checkReport(directory) {
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^compatibility-.*\.json$/);
  const report = JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8'));
  assert.equal(report.kitVersion, 'test-runtime');
  assert.deepEqual(report.results, [{ version: 'fixture-version', state: 'compatible' }]);
}

test('diagnose writes to the bootstrap-provided external directory without modifying the runtime folder', t => {
  const f = fixture(t);
  const external = path.join(f.temporary, '中文 cache', 'diagnostics');
  const before = fs.readdirSync(f.kitDir).sort();
  run(f.kitDir, external);
  checkReport(external);
  assert.deepEqual(fs.readdirSync(f.kitDir).sort(), before);
});

test('diagnose retains the standalone kit diagnostics location when no override is supplied', t => {
  const f = fixture(t);
  run(f.kitDir);
  checkReport(path.join(f.kitDir, 'diagnostics'));
});
