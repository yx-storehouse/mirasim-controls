'use strict';
const { diagnosticError } = require('./diagnostic-error.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const KIT_VERSION = '4.4.0';
const FEATURES = ['codex-speed', 'claude-ultracode', 'claude-fast'];
const PATCH_MARKER = 'mirasim-speed-picker:';
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function contained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('PATH_OUTSIDE_ROOT', '文件路径不在预期目录内');
  }
  return target;
}

function atomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.speed-kit-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function syntax(source, type) {
  const checked = spawnSync(process.execPath, [`--input-type=${type}`, '--check'], {
    input: source, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (checked.error || checked.status !== 0) {
    fail('SYNTAX_CHECK_FAILED', `候选代码语法检查失败：${checked.error?.message || checked.stderr?.slice(0, 1200)}`);
  }
}

function createManager(options = {}) {
  const home = path.resolve(options.home || os.homedir());
  const kitDir = path.resolve(options.kitDir || __dirname);
  const appRoot = path.join(home, '.mirasim', 'app');
  const backupRoot = path.join(home, '.mirasim-extras', 'speed-picker');
  const compat = options.compat || require('./combined-patch.cjs');
  const syntaxCheck = options.syntaxCheck || syntax;

  function discover() {
    if (!fs.existsSync(appRoot)) fail('MIRASIM_NOT_FOUND', '未找到当前用户的 Mirasim 更新包目录，请先安装并启动 Mirasim。');
    const versions = fs.readdirSync(appRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && VERSION.test(entry.name))
      .map(entry => entry.name).sort((a, b) => {
        const aa = a.split(/[.-]/), bb = b.split(/[.-]/);
        for (let i = 0; i < 3; i++) if (+aa[i] !== +bb[i]) return +bb[i] - +aa[i];
        return b.localeCompare(a);
      });
    if (!versions.length) fail('PAYLOAD_NOT_FOUND', '更新包目录中没有可识别的 Mirasim 版本。');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(path.join(appRoot, 'state.json'), 'utf8')); } catch {}
    if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
    const selected = [...new Set([state.good, state.pending].filter(value => VERSION.test(value || '') && versions.includes(value)))];
    return { versions, targets: selected.length ? selected : [versions[0]], selection: selected.length ? 'good-and-pending' : 'newest' };
  }

  function appDirectory(version) {
    if (!VERSION.test(version)) fail('INVALID_VERSION', '版本号格式无效');
    const root = fs.realpathSync(appRoot);
    const app = fs.realpathSync(contained(root, path.join(root, version)));
    contained(root, app);
    const payload = JSON.parse(fs.readFileSync(path.join(app, 'payload.json'), 'utf8'));
    if (payload.version !== version) fail('PAYLOAD_MISMATCH', '目录与 payload.json 的版本号不一致');
    return app;
  }

  function checkedFile(root, relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) fail('INVALID_RELATIVE_PATH', '备份记录中的相对路径无效');
    const file = contained(root, path.join(root, relative));
    const actual = fs.realpathSync(file);
    contained(fs.realpathSync(root), actual);
    return actual;
  }

  function receipts(version) {
    const base = path.join(backupRoot, version);
    const candidates = [path.join(base, 'installation.json')]; // v1 compatibility
    const builds = path.join(base, 'builds');
    if (fs.existsSync(builds)) {
      for (const entry of fs.readdirSync(builds, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-f0-9]{16,64}$/.test(entry.name)) {
          candidates.push(path.join(builds, entry.name, 'installation.json'));
        }
      }
    }
    return candidates.filter(file => fs.existsSync(file)).map(file => {
      contained(fs.realpathSync(backupRoot), fs.realpathSync(file));
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== version || !Array.isArray(data.files) || data.files.length < 3 || data.files.length > 18) fail('INVALID_RECEIPT', '恢复记录的版本或文件数量无效');
      const relatives = data.files.map(entry => entry.relative);
      if (new Set(relatives).size !== relatives.length || !relatives.includes('server-main.cjs') || !relatives.includes('renderer/integrity.json') ||
          relatives.filter(relative => /^renderer\/assets\/[^/\\]+\.js$/.test(relative)).length !== relatives.length - 2) {
        fail('INVALID_RECEIPT', '恢复记录包含非预期目标文件');
      }
      return { file, directory: path.dirname(file), data };
    }).sort((a, b) => String(b.data.installedAt || b.data.preparedAt || '').localeCompare(String(a.data.installedAt || a.data.preparedAt || '')));
  }

  function receiptState(app, receipt) {
    const states = receipt.data.files.map(entry => {
      try {
        const current = sha(fs.readFileSync(checkedFile(app, entry.relative)));
        return { entry, current };
      } catch { return { entry, current: null }; }
    });
    return states.every(({ entry, current }) => current !== null && current === entry.afterSha256) ? 'installed'
      : states.every(({ entry, current }) => current !== null && current === entry.beforeSha256) ? 'restored'
      : states.every(({ entry, current }) => current !== null && [entry.beforeSha256, entry.afterSha256, entry.inputSha256].includes(current)) ? 'interrupted' : 'changed';
  }

  function matchReceipt(version, app) {
    const all = receipts(version);
    for (const receipt of all) {
      const state = receiptState(app, receipt);
      if (state !== 'changed') return { ...receipt, state };
    }
    return all.length ? { ...all[0], state: 'changed' } : null;
  }

  function readSources(app) {
    const backend = checkedFile(app, 'server-main.cjs');
    const assets = fs.realpathSync(path.join(app, 'renderer', 'assets'));
    contained(app, assets);
    const sources = new Map();
    for (const file of fs.readdirSync(assets)) {
      if (!file.endsWith('.js')) continue;
      const relative = `renderer/assets/${file}`;
      const actual = checkedFile(app, relative);
      const stat = fs.statSync(actual);
      if (stat.size > 30 * 1024 * 1024) continue;
      const source = fs.readFileSync(actual, 'utf8');
      sources.set(relative, source);
    }
    return { backend: fs.readFileSync(backend, 'utf8'), assets: sources };
  }

  function inspect(version) {
    const app = appDirectory(version);
    const receipt = matchReceipt(version, app);
    if (receipt && ['installed', 'interrupted'].includes(receipt.state)) {
      const complete = FEATURES.every(feature => receipt.data.features?.includes(feature));
      return { version, state: receipt.state === 'installed' && !complete ? 'upgradeable' : receipt.state, receipt };
    }
    const sources = readSources(app);
    if (sources.backend.includes(PATCH_MARKER) || [...sources.assets.values()].some(source => source.includes(PATCH_MARKER))) {
      fail('UNRECOGNIZED_PATCH', '发现已有补丁但缺少匹配的恢复记录，拒绝叠加修改。');
    }
    const backend = compat.detectBackend(sources.backend);
    const frontend = compat.detectFrontendAssets(sources.assets);
    return { version, state: receipt?.state === 'restored' ? 'restored-compatible' : 'compatible', evidence: { backend: backend.evidence, frontend: frontend.evidence } };
  }

  function plan(version) {
    const app = appDirectory(version);
    const sources = readSources(app);
    const existing = matchReceipt(version, app);
    const baselineAssets = new Map(sources.assets);
    const savedOriginals = new Map();
    if (['installed', 'interrupted'].includes(existing?.state)) {
      for (const entry of existing.data.files) {
        const bytes = fs.readFileSync(checkedFile(path.join(existing.directory, 'original'), entry.relative));
        if (sha(bytes) !== entry.beforeSha256) fail('BACKUP_DAMAGED', '旧版原文件备份校验失败，拒绝升级');
        savedOriginals.set(entry.relative, bytes);
        if (entry.relative.startsWith('renderer/assets/')) baselineAssets.set(entry.relative, bytes.toString('utf8'));
      }
    }
    const frontend = compat.patchFrontendAssets(baselineAssets, { speedTemplate: fs.readFileSync(path.join(kitDir, 'speed-picker.template.js'), 'utf8') });
    if (!(frontend.files instanceof Map) || !frontend.files.size || frontend.files.size > 16) fail('INVALID_FRONTEND_PLAN', '前端修改计划无效');
    for (const relative of frontend.files.keys()) {
      if (!/^renderer\/assets\/[^/\\]+\.js$/.test(relative) || !baselineAssets.has(relative)) fail('INVALID_FRONTEND_PLAN', '前端计划包含未知文件');
    }
    const frontPaths = [...new Set([...frontend.files.keys(), ...savedOriginals.keys()].filter(relative => relative.startsWith('renderer/assets/')))].sort();
    if (frontPaths.length > 16) fail('INVALID_FRONTEND_PLAN', '新旧前端文件集合过大，拒绝生成无法恢复的记录');
    const relatives = ['server-main.cjs', ...frontPaths, 'renderer/integrity.json'];
    const physical = relatives.map(relative => checkedFile(app, relative));
    if (new Set(physical.map(file => file.toLowerCase())).size !== physical.length) fail('DUPLICATE_TARGET', '多个逻辑文件指向同一物理文件');
    const inputs = new Map(relatives.map(relative => [relative, fs.readFileSync(checkedFile(app, relative))]));
    const original = new Map(relatives.map(relative => [relative, savedOriginals.get(relative) || inputs.get(relative)]));
    const integrity = JSON.parse(original.get('renderer/integrity.json'));
    const updated = new Map();
    for (const relative of frontPaths) {
      const key = relative.slice('renderer/'.length), bytes = original.get(relative);
      if (integrity.version !== 1 || integrity.files?.[key]?.sha256 !== sha(bytes) || integrity.files?.[key]?.size !== bytes.length) fail('INTEGRITY_MISMATCH', '原前端文件与完整性清单不一致，拒绝在未知修改上安装。');
      const patched = Buffer.from(frontend.files.get(relative) ?? baselineAssets.get(relative));
      syntaxCheck(patched.toString('utf8'), 'module');
      integrity.files[key] = { ...integrity.files[key], size: patched.length, sha256: sha(patched) };
      updated.set(relative, patched);
    }
    const backend = compat.patchBackend(original.get('server-main.cjs').toString('utf8'));
    syntaxCheck(backend.source, 'commonjs');
    updated.set('server-main.cjs', Buffer.from(backend.source));
    updated.set('renderer/integrity.json', jsonBytes(integrity));
    const buildId = sha([...original.values()].map(sha).join(':') + ':' + KIT_VERSION).slice(0, 24);
    const entries = relatives.map(relative => ({ relative, beforeSha256: sha(original.get(relative)), inputSha256: sha(inputs.get(relative)), afterSha256: sha(updated.get(relative)), size: updated.get(relative).length }));
    return { app, original, inputs, updated, manifest: {
      formatVersion: 5, kitVersion: KIT_VERSION, features: FEATURES, version, buildId, preparedAt: new Date().toISOString(),
      files: entries, changes: [...(backend.changes || []), ...(frontend.changes || [])],
      evidence: { backend: backend.evidence, frontend: frontend.evidence },
    } };
  }

  function restoreReceipt(version, receipt) {
    const app = appDirectory(version);
    const state = receiptState(app, receipt);
    if (state === 'changed') fail('RESTORE_REFUSED', '程序文件已更新或被其他补丁修改，拒绝用旧备份覆盖。');
    const pending = receipt.data.files.map(entry => {
      const target = checkedFile(app, entry.relative);
      const backup = checkedFile(path.join(receipt.directory, 'original'), entry.relative);
      const original = fs.readFileSync(backup);
      if (sha(original) !== entry.beforeSha256) fail('BACKUP_DAMAGED', '原文件备份校验失败');
      return { ...entry, target, original, current: fs.readFileSync(target) };
    });
    const completed = [];
    try {
      for (const entry of pending) {
        if (sha(fs.readFileSync(entry.target)) !== sha(entry.current)) fail('FILE_CHANGED_DURING_RESTORE', '恢复过程中目标文件发生变化');
        atomic(entry.target, entry.original);
        completed.push(entry);
        if (sha(fs.readFileSync(entry.target)) !== entry.beforeSha256) fail('RESTORE_VERIFY_FAILED', '恢复后的文件校验失败');
      }
    } catch (error) {
      for (const entry of completed.reverse()) if (sha(fs.readFileSync(entry.target)) === entry.beforeSha256) atomic(entry.target, entry.current);
      throw error;
    }
    return { version, state: 'restored', reloadRequired: state !== 'restored' };
  }

  function restore(version) {
    const receipt = matchReceipt(version, appDirectory(version));
    if (!receipt) return { version, state: 'not-installed' };
    return restoreReceipt(version, receipt);
  }

  function install(version) {
    const inspected = inspect(version);
    if (inspected.state === 'installed') return { version, state: 'already-installed' };
    // Plan directly from verified pristine backups even after interruption.
    // Validate the complete new build before touching a usable older feature.
    const candidate = plan(version);
    const { manifest, original, inputs, updated, app } = candidate;
    const directory = contained(backupRoot, path.join(backupRoot, version, 'builds', manifest.buildId));
    fs.mkdirSync(directory, { recursive: true });
    contained(fs.realpathSync(backupRoot), fs.realpathSync(directory));
    for (const entry of manifest.files) {
      if (sha(fs.readFileSync(checkedFile(app, entry.relative))) !== entry.inputSha256) fail('STALE_PLAN', '生成候选期间程序文件发生变化，请重试');
      const destination = contained(directory, path.join(directory, 'original', entry.relative));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      contained(fs.realpathSync(directory), fs.realpathSync(path.dirname(destination)));
      if (fs.existsSync(destination)) {
        if (sha(fs.readFileSync(destination)) !== entry.beforeSha256) fail('BACKUP_CONFLICT', '已有备份内容不匹配，拒绝覆盖备份');
      } else fs.writeFileSync(destination, original.get(entry.relative), { flag: 'wx' });
    }
    const receipt = path.join(directory, 'installation.json');
    atomic(receipt, jsonBytes({ ...manifest, state: 'installing' }));
    const completed = [];
    try {
      for (const entry of manifest.files) {
        const target = checkedFile(app, entry.relative);
        if (sha(fs.readFileSync(target)) !== entry.inputSha256) fail('STALE_PLAN', '安装过程中程序文件发生变化，正在回滚');
        atomic(target, updated.get(entry.relative));
        completed.push(entry);
        if (sha(fs.readFileSync(target)) !== entry.afterSha256) fail('WRITE_VERIFY_FAILED', '安装后文件校验失败');
      }
      atomic(receipt, jsonBytes({ ...manifest, state: 'installed', installedAt: new Date().toISOString() }));
    } catch (error) {
      for (const entry of completed.reverse()) {
        const target = checkedFile(app, entry.relative);
        if (sha(fs.readFileSync(target)) === entry.afterSha256) atomic(target, inputs.get(entry.relative));
      }
      throw error;
    }
    return { version, state: 'installed', reloadRequired: true, buildId: manifest.buildId };
  }

  function status(version) {
    const app = appDirectory(version);
    const receipt = matchReceipt(version, app);
    if (receipt) return { version, state: receipt.state === 'installed' && !FEATURES.every(feature => receipt.data.features?.includes(feature)) ? 'upgradeable' : receipt.state };
    return { version, state: 'not-installed' };
  }

  function diagnose(version) {
    const result = { version };
    try { const info = inspect(version); result.state = info.state; result.evidence = info.evidence; }
    catch (error) { result.state = 'needs-adaptation'; result.error = diagnosticError(error); }
    try {
      const app = appDirectory(version), sources = readSources(app);
      const candidates = [...sources.assets].filter(([name, source]) => source.includes('data-route-pick') || source.includes('case"catalog"'));
      result.files = [
        { name: 'server-main.cjs', bytes: Buffer.byteLength(sources.backend), sha256: sha(sources.backend) },
        ...candidates.map(([name, source]) => ({ name, bytes: Buffer.byteLength(source), sha256: sha(source) })),
      ];
      const snippets = (source, anchors) => anchors.flatMap(anchor => {
        const at = source.indexOf(anchor);
        return at < 0 ? [] : [{ anchor, code: source.slice(Math.max(0, at - 450), at + 850) }];
      });
      if (result.state === 'needs-adaptation') result.staticCodeSamples = {
        backend: snippets(sources.backend, ['service_tier=', 'codexServiceTier', 'serviceTier applies to codex only']),
        frontend: candidates.map(([name, source]) => ({ name, snippets: snippets(source, ['data-route-pick', 'hub.selectEffort', 'case"catalog"']) })),
      };
    } catch (error) { result.fileError = error.code || error.message; }
    return result;
  }

  return { discover, inspect, install, restore, status, diagnose, plan, appRoot, backupRoot, kitDir };
}

module.exports = { KIT_VERSION, FEATURES, createManager, contained, sha, atomic };
