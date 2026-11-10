'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RUNTIME_FILES } = require('./update-runtime.cjs');
const root = path.resolve(__dirname, '..');

function generateManifest() {
  const versions = ['manager.cjs', 'cache-manager.cjs', 'bundled-manager.cjs'].map(name => {
    const source = fs.readFileSync(path.join(root, 'runtime', name), 'utf8');
    const match = /const KIT_VERSION = ['"](\d+\.\d+\.\d+)['"]/.exec(source);
    if (!match) throw new Error(`Missing runtime version in ${name}`);
    return match[1];
  });
  if (new Set(versions).size !== 1) throw new Error('Runtime version constants disagree');
  const files = [...RUNTIME_FILES].sort().map(name => {
    const relative = `runtime/${name}`;
    const location = path.join(root, relative);
    if (!fs.lstatSync(location).isFile()) throw new Error(`Not a regular runtime file: ${relative}`);
    const bytes = fs.readFileSync(location);
    if (name === 'run.ps1' && !bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
      throw new Error('runtime/run.ps1 requires UTF-8 BOM for Windows PowerShell');
    }
    return { path: relative, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  return { schemaVersion: 1, version: versions[0], files };
}

function main() {
  const generated = generateManifest();
  const output = path.join(root, 'release.json');
  if (process.argv.includes('--check')) {
    const actual = JSON.parse(fs.readFileSync(output, 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(generated)) throw new Error('release.json is stale; run node scripts/release-manifest.cjs');
    console.log(`Manifest verified: ${generated.version}, ${generated.files.length} files`);
  } else {
    fs.writeFileSync(output, JSON.stringify(generated, null, 2) + '\n');
    console.log(`Manifest generated: ${generated.version}, ${generated.files.length} files`);
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { generateManifest };
