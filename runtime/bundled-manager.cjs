'use strict';
const { diagnosticError } = require('./diagnostic-error.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseAsar, replaceAsar } = require('./asar.cjs');
const KIT_VERSION = '4.4.0';
const FEATURES = ['codex-speed', 'claude-ultracode', 'claude-fast'];
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const asJson = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('PATH_OUTSIDE_ROOT', '路径不在预期目录内');
  return file;
}
function atomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.controls-${process.pid}-${crypto.randomBytes(5).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, content, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function syntax(source, type) {
  const result = spawnSync(process.execPath, [`--input-type=${type}`, '--check'], {
    input: source, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.error || result.status !== 0) fail('SYNTAX_FAILED', `候选代码语法检查失败：${result.error?.message || result.stderr?.slice(0, 800)}`);
}

// Read the documented Electron fuse wire. Never alter executable flags or
// bypass native archive validation. A protected or unknown build is refused.
function readArchiveFuse(executable) {
  const bytes = fs.readFileSync(executable), sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const at = bytes.indexOf(sentinel), start = at + sentinel.length;
  if (at < 0 || bytes.indexOf(sentinel, at + 1) >= 0 || bytes[start] !== 1 || bytes[start + 1] < 5 || start + 2 + bytes[start + 1] > bytes.length) {
    fail('UNKNOWN_ELECTRON_FUSES', '无法确认安装版的原生资源校验配置，拒绝修改 ASAR');
  }
  const archiveValidation = bytes[start + 2 + 4];
  if (archiveValidation !== 0x30) fail('PROTECTED_ASAR', '此安装版启用了或无法确认原生 ASAR 完整性保护，需要单独适配；不会修改保护开关');
  return { embeddedAsarIntegrityValidation: false };
}

function createBundledManager(options = {}) {
  const home = path.resolve(options.home || os.homedir());
  const kitDir = path.resolve(options.kitDir || __dirname);
  const compat = options.compat || require('./combined-patch.cjs');
  const syntaxCheck = options.syntaxCheck || syntax;
  const fuseCheck = options.fuseCheck || readArchiveFuse;
  const backupRoot = path.join(home, '.mirasim-extras', 'speed-picker', 'bundled');
  const candidates = options.resourcesDir ? [options.resourcesDir] : [
    path.join(home, 'AppData', 'Local', 'Programs', '@mirasimdesktop', 'resources'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Mirasim', 'resources'),
    ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, 'Mirasim', 'resources')] : []),
  ];
  const resources = candidates.find(dir => fs.existsSync(path.join(dir, 'app.asar')) && fs.existsSync(path.join(dir, 'server-main.cjs')));
  if (!resources) return null;
  const resourceRoot = fs.realpathSync(resources);
  function target(relative) {
    if (!['app.asar', 'server-main.cjs'].includes(relative)) fail('INVALID_BUNDLED_PATH', '恢复记录包含非预期安装文件');
    const file = fs.realpathSync(path.join(resourceRoot, relative));
    inside(resourceRoot, file);
    return file;
  }
  function metadata() {
    const archive = parseAsar(fs.readFileSync(target('app.asar')));
    const pkg = JSON.parse(archive.readFile('package.json').toString('utf8'));
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version || '')) fail('BUNDLED_VERSION_UNKNOWN', '安装版缺少有效版本号');
    const main = archive.readFile(pkg.main || 'dist/main.cjs').toString('utf8');
    const matches = [...main.matchAll(/\{(?:"abi"|abi):(\d+),(?:"surface"|surface):/g)];
    if (matches.length !== 1) fail('BUNDLED_ABI_UNKNOWN', '无法唯一识别安装版 ABI，拒绝猜测缓存版本是否会加载');
    return { version: pkg.version, abi: Number(matches[0][1]), resources: resourceRoot, kind: 'bundled' };
  }
  function receipts(meta) {
    const root = path.join(backupRoot, meta.version, 'builds');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name))
      .map(entry => path.join(root, entry.name, 'installation.json')).filter(fs.existsSync).map(file => {
        inside(fs.realpathSync(backupRoot), fs.realpathSync(file));
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.version !== meta.version || data.kind !== 'bundled' || data.resources !== resourceRoot || !Array.isArray(data.files) || data.files.length !== 2 ||
          !['app.asar', 'server-main.cjs'].every(relative => data.files.filter(f => f.relative === relative).length === 1)) fail('BAD_BUNDLED_RECEIPT', '安装版恢复记录无效');
        return { data, file, directory: path.dirname(file) };
      }).sort((a, b) => String(b.data.installedAt || b.data.preparedAt).localeCompare(String(a.data.installedAt || a.data.preparedAt)));
  }
  function receiptState(receipt) {
    const states = receipt.data.files.map(entry => {
      const hash = sha(fs.readFileSync(target(entry.relative)));
      return { entry, hash };
    });
    return states.every(({ entry, hash }) => hash === entry.afterSha256) ? 'installed'
      : states.every(({ entry, hash }) => hash === entry.beforeSha256) ? 'restored'
      : states.every(({ entry, hash }) => [entry.beforeSha256, entry.afterSha256, entry.inputSha256].includes(hash)) ? 'interrupted' : 'changed';
  }
  function matching(meta) {
    const all = receipts(meta);
    for (const receipt of all) { const state = receiptState(receipt); if (state !== 'changed') return { ...receipt, state }; }
    return all.length ? { ...all[0], state: 'changed' } : null;
  }
  function rendererAssets(archive) {
    const sources = new Map();
    for (const [name, entry] of archive.entries) {
      if (!name.startsWith('dist/renderer/assets/') || !name.endsWith('.js') || entry.type !== 'file' || entry.size > 30 * 1024 * 1024) continue;
      const source = archive.readFile(name).toString('utf8');
      sources.set(name, source);
    }
    return sources;
  }
  function inspect() {
    const meta = metadata(), receipt = matching(meta);
    if (receipt && ['installed', 'interrupted'].includes(receipt.state)) return { ...meta,
      state: receipt.state === 'installed' && !FEATURES.every(feature => receipt.data.features?.includes(feature)) ? 'upgradeable' : receipt.state, receipt };
    const assets = rendererAssets(parseAsar(fs.readFileSync(target('app.asar'))));
    const backend = compat.detectBackend(fs.readFileSync(target('server-main.cjs'), 'utf8'));
    const frontend = compat.detectFrontendAssets(assets);
    return { ...meta, state: 'compatible', evidence: { backend: backend.evidence, frontend: frontend.evidence } };
  }
  function plan() {
    const meta = metadata(), receipt = matching(meta);
    const inputs = new Map(['server-main.cjs', 'app.asar'].map(relative => [relative, fs.readFileSync(target(relative))]));
    const original = new Map([...inputs].map(([relative, bytes]) => {
      if (!receipt || !['installed', 'interrupted'].includes(receipt.state)) return [relative, bytes];
      const entry = receipt.data.files.find(f => f.relative === relative);
      const backup = fs.realpathSync(path.join(receipt.directory, 'original', relative));
      inside(fs.realpathSync(receipt.directory), backup);
      const saved = fs.readFileSync(backup);
      if (sha(saved) !== entry.beforeSha256) fail('BACKUP_DAMAGED', '安装版原件备份校验失败');
      return [relative, saved];
    }));
    const archive = parseAsar(original.get('app.asar')), assets = rendererAssets(archive);
    const integrityPath = 'dist/renderer/integrity.json';
    const integrity = JSON.parse(archive.readFile(integrityPath).toString('utf8'));
    const backend = compat.patchBackend(original.get('server-main.cjs').toString('utf8'));
    const frontend = compat.patchFrontendAssets(assets, { speedTemplate: fs.readFileSync(path.join(kitDir, 'speed-picker.template.js'), 'utf8') });
    if (!(frontend.files instanceof Map) || !frontend.files.size || frontend.files.size > 16) fail('INVALID_FRONTEND_PLAN', 'ASAR 前端修改计划无效');
    syntaxCheck(backend.source, 'commonjs');
    const replacements = new Map();
    for (const [name, source] of frontend.files) {
      if (!assets.has(name)) fail('INVALID_FRONTEND_PLAN', 'ASAR 前端计划包含未知资源');
      const key = name.slice('dist/renderer/'.length), previous = archive.readFile(name), bytes = Buffer.from(source);
      if (integrity.version !== 1 || integrity.files?.[key]?.sha256 !== sha(previous) || integrity.files[key].size !== previous.length) fail('BUNDLED_INTEGRITY_MISMATCH', '安装版前端与原资源清单不一致');
      syntaxCheck(bytes.toString('utf8'), 'module');
      integrity.files[key] = { ...integrity.files[key], size: bytes.length, sha256: sha(bytes) };
      replacements.set(name, bytes);
    }
    replacements.set(integrityPath, asJson(integrity));
    const changedArchive = replaceAsar(original.get('app.asar'), replacements);
    const verified = parseAsar(changedArchive);
    for (const [name, bytes] of replacements) if (!verified.readFile(name).equals(bytes)) fail('ASAR_VERIFY_FAILED', 'ASAR 候选读取校验失败');
    const fuse = fuseCheck(path.join(path.dirname(resourceRoot), 'Mirasim.exe'));
    const updated = new Map([['server-main.cjs', Buffer.from(backend.source)], ['app.asar', changedArchive]]);
    const buildId = sha([...original.values()].map(sha).join(':') + ':' + KIT_VERSION).slice(0, 24);
    return { original, inputs, updated, manifest: { ...meta, kind: 'bundled', kitVersion: KIT_VERSION, features: FEATURES,
      buildId, preparedAt: new Date().toISOString(), fuse, renderer: [...frontend.files.keys()][0], renderers: [...frontend.files.keys()],
      changes: [...backend.changes, ...frontend.changes],
      files: [...original].map(([relative, bytes]) => ({ relative, beforeSha256: sha(bytes), inputSha256: sha(inputs.get(relative)), afterSha256: sha(updated.get(relative)) })),
    } };
  }
  function install() {
    const state = inspect();
    if (state.state === 'installed') return { version: state.version, kind: 'bundled', state: 'already-installed' };
    const p = plan(), { manifest } = p;
    fuseCheck(path.join(path.dirname(resourceRoot), 'Mirasim.exe'));
    const directory = path.join(backupRoot, manifest.version, 'builds', manifest.buildId);
    fs.mkdirSync(path.join(directory, 'original'), { recursive: true });
    inside(fs.realpathSync(backupRoot), fs.realpathSync(directory));
    for (const entry of manifest.files) {
      if (sha(fs.readFileSync(target(entry.relative))) !== entry.inputSha256) fail('STALE_BUNDLED_PLAN', '安装版在准备期间发生变化');
      const backup = path.join(directory, 'original', entry.relative);
      inside(fs.realpathSync(directory), fs.realpathSync(path.dirname(backup)));
      if (fs.existsSync(backup)) { if (sha(fs.readFileSync(backup)) !== entry.beforeSha256) fail('BACKUP_CONFLICT', '安装版备份冲突'); }
      else fs.writeFileSync(backup, p.original.get(entry.relative), { flag: 'wx' });
    }
    const receiptFile = path.join(directory, 'installation.json');
    atomic(receiptFile, asJson({ ...manifest, state: 'installing' }));
    const completed = [];
    try {
      for (const entry of manifest.files) {
        if (sha(fs.readFileSync(target(entry.relative))) !== entry.inputSha256) fail('STALE_BUNDLED_PLAN', '安装过程中应用正在更新');
        atomic(target(entry.relative), p.updated.get(entry.relative)); completed.push(entry);
        if (sha(fs.readFileSync(target(entry.relative))) !== entry.afterSha256) fail('BUNDLED_WRITE_VERIFY_FAILED', '安装版写入后校验失败');
      }
      atomic(receiptFile, asJson({ ...manifest, state: 'installed', installedAt: new Date().toISOString() }));
    } catch (error) {
      for (const entry of completed.reverse()) if (sha(fs.readFileSync(target(entry.relative))) === entry.afterSha256) atomic(target(entry.relative), p.inputs.get(entry.relative));
      if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) fail('BUNDLED_FILE_IN_USE', '安装文件被占用或不可写，已回滚本次写入；请完整退出 Mirasim 后重新运行 BAT');
      throw error;
    }
    return { version: manifest.version, kind: 'bundled', state: 'installed', reloadRequired: true };
  }
  function restore() {
    const meta = metadata(), receipt = matching(meta);
    if (!receipt) return { ...meta, state: 'not-installed' };
    if (receipt.state === 'changed') fail('BUNDLED_RESTORE_REFUSED', '安装版已更新或有未知修改，拒绝覆盖');
    const pending = receipt.data.files.map(entry => {
      const backup = fs.realpathSync(path.join(receipt.directory, 'original', entry.relative));
      inside(fs.realpathSync(receipt.directory), backup);
      const bytes = fs.readFileSync(backup), current = fs.readFileSync(target(entry.relative));
      if (sha(bytes) !== entry.beforeSha256) fail('BACKUP_DAMAGED', '安装版原件备份损坏');
      return { ...entry, bytes, current };
    });
    const completed = [];
    try {
      for (const entry of pending) {
        if (sha(fs.readFileSync(target(entry.relative))) !== sha(entry.current)) fail('STALE_BUNDLED_RESTORE', '恢复期间应用正在更新');
        atomic(target(entry.relative), entry.bytes); completed.push(entry);
        if (sha(fs.readFileSync(target(entry.relative))) !== entry.beforeSha256) fail('BUNDLED_RESTORE_VERIFY_FAILED', '恢复后校验失败');
      }
    } catch (error) { for (const entry of completed.reverse()) if (sha(fs.readFileSync(target(entry.relative))) === entry.beforeSha256) atomic(target(entry.relative), entry.current); throw error; }
    return { ...meta, state: 'restored', reloadRequired: true };
  }
  function status() { const meta = metadata(), receipt = matching(meta); return { ...meta,
    state: receipt?.state === 'installed' && !FEATURES.every(feature => receipt.data.features?.includes(feature)) ? 'upgradeable' : receipt?.state || 'not-installed' }; }
  function diagnose() {
    const meta = metadata(); let state;
    try { state = inspect(); } catch (error) { state = { state: 'needs-adaptation', error: diagnosticError(error) }; }
    return { version: meta.version, kind: 'bundled', abi: meta.abi, state: state.state, error: state.error,
      evidence: state.evidence, files: ['server-main.cjs', 'app.asar'].map(relative => { const bytes = fs.readFileSync(target(relative)); return { name: relative, bytes: bytes.length, sha256: sha(bytes) }; }) };
  }
  return { metadata, inspect, plan, install, restore, status, diagnose, resources: resourceRoot, backupRoot };
}

module.exports = { createBundledManager, readArchiveFuse, KIT_VERSION, FEATURES };
