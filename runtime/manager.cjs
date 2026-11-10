'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cacheModule = require('./cache-manager.cjs');
const { createBundledManager } = require('./bundled-manager.cjs');
const KIT_VERSION = '4.4.0';
const FEATURES = ['codex-speed', 'claude-ultracode', 'claude-fast'];

function compareVersion(a, b) {
  const aa = a.split('-'), bb = b.split('-');
  const an = aa[0].split('.').map(Number), bn = bb[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if (an[i] !== bn[i]) return an[i] - bn[i];
  if (!aa[1] && bb[1]) return 1;
  if (aa[1] && !bb[1]) return -1;
  return (aa[1] || '').localeCompare(bb[1] || '');
}

function createManager(options = {}) {
  const home = path.resolve(options.home || os.homedir());
  const cache = cacheModule.createManager(options);
  const bundled = options.detectBundled === false ? null : createBundledManager(options);
  function discover() {
    let cacheInfo = { versions: [], targets: [], selection: 'none' };
    try { cacheInfo = cache.discover(); }
    catch (error) { if (!bundled) throw error; }
    if (!bundled) return { ...cacheInfo, labels: Object.fromEntries(cacheInfo.targets.map(version => [version, `缓存版 ${version}`])) };
    const meta = bundled.metadata();
    const targets = [`bundled:${meta.version}`];
    const labels = { [targets[0]]: `安装版 ${meta.version}` };
    const ignored = [];
    for (const version of cacheInfo.versions) {
      let payload;
      try { payload = JSON.parse(fs.readFileSync(path.join(home, '.mirasim', 'app', version, 'payload.json'), 'utf8')); }
      catch { ignored.push({ version, reason: '发布元数据不可读' }); continue; }
      const newer = compareVersion(version, meta.version) > 0;
      const compatible = typeof payload.minShellAbi === 'number' && meta.abi >= payload.minShellAbi && meta.abi <= (payload.maxShellAbi ?? Number.MAX_SAFE_INTEGER);
      if (!newer || !compatible) {
        ignored.push({ version, reason: !newer ? '不高于安装版，不会覆盖安装版运行' : `ABI 不兼容，当前安装版 ABI=${meta.abi}`, minAbi: payload.minShellAbi, maxAbi: payload.maxShellAbi });
        continue;
      }
      if (cacheInfo.targets.includes(version)) {
        const id = `cache:${version}`;
        targets.push(id); labels[id] = `可加载缓存 ${version}`;
      }
    }
    return { versions: cacheInfo.versions, targets, labels, selection: 'bundled-and-compatible-cache', bundledVersion: meta.version, shellAbi: meta.abi, ignored };
  }
  function route(target) {
    if (target.startsWith('bundled:')) {
      if (!bundled || target.slice(8) !== bundled.metadata().version) throw new Error('安装版在检测后已发生变化，请重新运行');
      return { manager: bundled, args: [] };
    }
    return { manager: cache, args: [target.startsWith('cache:') ? target.slice(6) : target] };
  }
  const api = { discover, kitDir: path.resolve(options.kitDir || __dirname), appRoot: cache.appRoot, backupRoot: cache.backupRoot };
  for (const method of ['inspect', 'plan', 'install', 'restore', 'status', 'diagnose']) {
    api[method] = target => { const selected = route(target); return selected.manager[method](...selected.args); };
  }
  return api;
}

module.exports = { KIT_VERSION, FEATURES, createManager, compareVersion,
  contained: cacheModule.contained, sha: cacheModule.sha, atomic: cacheModule.atomic };
