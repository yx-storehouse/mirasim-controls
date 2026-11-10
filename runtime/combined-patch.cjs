'use strict';
const speed = require('./compat.cjs');
const claude = require('./claude-controls-backend.cjs');
const frontend = require('./claude-controls-frontend.cjs');
const assets = require('./frontend-assets.cjs');

function detectBackend(source) {
  const a = speed.detectBackend(source);
  const b = claude.detectClaudeControlsBackend(source);
  return { compatible: true, evidence: [...a.evidence, ...b.evidence], metadata: { speed: a.spec, claude: b.metadata } };
}

function detectFrontend(source) { return speed.detectFrontend(source); }

function patchBackend(source) {
  const a = speed.patchBackend(source);
  const b = claude.patchClaudeControlsBackend(a.source);
  return { source: b.source, changes: [...a.changes, ...b.changes], evidence: [...a.evidence, ...b.evidence], metadata: { speed: a.metadata, claude: b.metadata } };
}

function patchFrontend(source, speedTemplate) {
  return frontend.patchControlsFrontend(source, { speedTemplate });
}

module.exports = { detectBackend, detectFrontend, patchBackend, patchFrontend,
  detectFrontendAssets: assets.detectFrontendAssets, patchFrontendAssets: assets.patchFrontendAssets };
