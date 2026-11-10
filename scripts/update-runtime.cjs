'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// This is the complete distributable runtime. Application samples, backups,
// account settings, diagnostics and research files must never enter this list.
const RUNTIME_FILES = Object.freeze([
  'run.ps1',
  'main.cjs',
  'manager.cjs',
  'cache-manager.cjs',
  'bundled-manager.cjs',
  'asar.cjs',
  'combined-patch.cjs',
  'compat.cjs',
  'frontend-assets.cjs',
  'diagnostic-error.cjs',
  'claude-controls-backend.cjs',
  'claude-controls-frontend.cjs',
  'ultracode-backend.cjs',
  'ultracode-frontend.cjs',
  'speed-picker.template.js',
  'ultracode-toggle.template.js',
  'claude-fast-toggle.template.js',
]);

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE = path.resolve(REPOSITORY_ROOT, '..', 'mirasim-speed-picker', 'controls-v44');
const DIAGNOSTIC_ANCHOR = "const file = path.join(manager.kitDir, 'diagnostics', name);";
const DIAGNOSTIC_OVERLAY = "const diagnosticsDir = process.env.MIRASIM_CONTROLS_DIAGNOSTICS || path.join(manager.kitDir, 'diagnostics');\n    const file = path.join(diagnosticsDir, name);";

function withExternalDiagnostics(bytes) {
  const source = bytes.toString('utf8');
  if (source.includes('MIRASIM_CONTROLS_DIAGNOSTICS')) {
    if (source.split(DIAGNOSTIC_OVERLAY).length !== 2 || source.includes(DIAGNOSTIC_ANCHOR)) {
      throw new Error('Existing diagnostic-directory support has an unknown structure; review main.cjs before importing.');
    }
    return bytes;
  }
  if (source.split(DIAGNOSTIC_ANCHOR).length !== 2) {
    throw new Error('Diagnostic output path anchor is missing or ambiguous; review main.cjs before importing.');
  }
  return Buffer.from(source.replace(DIAGNOSTIC_ANCHOR, DIAGNOSTIC_OVERLAY), 'utf8');
}

function syncRuntime(sourceDirectory = DEFAULT_SOURCE, { regenerateManifest = true } = {}) {
  const source = fs.realpathSync(path.resolve(sourceDirectory));
  const target = path.join(REPOSITORY_ROOT, 'runtime');
  const builder = path.join(__dirname, 'release-manifest.cjs');
  if (source === target) throw new Error('Source must be separate from the repository runtime directory.');
  if (regenerateManifest && !fs.existsSync(builder)) {
    throw new Error('Missing scripts/release-manifest.cjs. Use --skip-manifest only during initial repository preparation.');
  }

  // Read and validate the entire explicit source set before modifying runtime.
  const files = RUNTIME_FILES.map(name => {
    const file = path.join(source, name);
    if (!fs.lstatSync(file).isFile()) throw new Error(`Source is not a regular file: ${name}`);
    const bytes = fs.readFileSync(file);
    return { name, bytes: name === 'main.cjs' ? withExternalDiagnostics(bytes) : bytes };
  });
  if (!files.find(file => file.name === 'run.ps1').bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new Error('run.ps1 must preserve its UTF-8 BOM for Windows PowerShell 5.1.');
  }
  const versions = ['manager.cjs', 'cache-manager.cjs', 'bundled-manager.cjs'].map(name => {
    const source = files.find(file => file.name === name).bytes.toString('utf8');
    const matches = [...source.matchAll(/const KIT_VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'/g)];
    if (matches.length !== 1) throw new Error(`Could not determine runtime version: ${name}`);
    return matches[0][1];
  });
  if (new Set(versions).size !== 1) throw new Error('Runtime manager versions do not agree.');

  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (!entry.isFile() || !RUNTIME_FILES.includes(entry.name)) {
      throw new Error(`Unexpected runtime item; review it before syncing: ${entry.name}`);
    }
  }
  for (const { name, bytes } of files) fs.writeFileSync(path.join(target, name), bytes);
  if (regenerateManifest) {
    const result = spawnSync(process.execPath, [builder], { cwd: REPOSITORY_ROOT, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Release manifest generation failed (${result.status}). Review runtime before committing.`);
  }
  return { version: versions[0], files: files.length, manifestRegenerated: regenerateManifest };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      console.log('Usage: node scripts/update-runtime.cjs [source-directory] [--skip-manifest]');
      console.log('Copies only the explicit runtime allowlist, then regenerates release.json.');
      process.exit(0);
    }
    const positional = args.filter(arg => arg !== '--skip-manifest');
    if (positional.length > 1 || positional.some(arg => arg.startsWith('--'))) {
      throw new Error('Usage: node scripts/update-runtime.cjs [source-directory] [--skip-manifest]');
    }
    console.log(JSON.stringify(syncRuntime(positional[0] || DEFAULT_SOURCE, { regenerateManifest: !args.includes('--skip-manifest') }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { RUNTIME_FILES, syncRuntime, withExternalDiagnostics };
