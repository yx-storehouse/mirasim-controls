'use strict';

const fs = require('node:fs');
const path = require('node:path');
const compat = require('./compat.cjs');

const MARKER = '/* mirasim-unified-controls:v3 */';
const TOGGLE_MARKER = '/* mirasim-ultracode-toggle:v1 */';
const SPEED_NAME = 'MirasimSpeedPickerV1';
const CODEX_NAME = 'MirasimCodexSpeedPickerV3';
const TOGGLE_NAME = 'MirasimUltracodeToggleV1';

function readTemplate(name) { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }

function replaceOnce(source, before, after, label) {
  const start = source.indexOf(before);
  if (start < 0 || source.indexOf(before, start + before.length) >= 0) {
    throw new compat.CompatibilityError('structure-mismatch', `${label}: expected exactly one matching anchor`);
  }
  return source.slice(0, start) + after + source.slice(start + before.length);
}

function createUltracodeSource(metadata, template = readTemplate('ultracode-toggle.template.js')) {
  if (typeof template !== 'string' || !template.includes(TOGGLE_MARKER)) {
    throw new TypeError('A complete Ultracode toggle template is required');
  }
  let source = template;
  for (const [key, value] of Object.entries(metadata.symbols)) source = source.replaceAll(`__${key}__`, value);
  if (/__[A-Z]+__/.test(source)) throw new compat.CompatibilityError('invalid-template', 'Unresolved Ultracode template symbol');
  return source;
}

/** Extend only a newly prepared speed candidate, never an unknown installed file. */
function applyUltracodeToSpeedPatched(source, metadata, template) {
  if (typeof source !== 'string' || !metadata?.symbols?.JSX) throw new TypeError('Source and verified renderer metadata are required');
  if (source.includes(MARKER) || source.includes(TOGGLE_MARKER)) {
    throw new compat.CompatibilityError('already-patched', 'Unified controls already exist; prepare from the original backup');
  }
  for (const marker of ['/* mirasim-speed-picker:v1 */', '/* mirasim-speed-picker:compact */', '/* mirasim-speed-picker:desktop */']) {
    if (!source.includes(marker)) throw new compat.CompatibilityError('structure-mismatch', `Incomplete speed candidate: ${marker}`);
  }
  const component = createUltracodeSource(metadata, template);
  const jsx = metadata.symbols.JSX;
  const wrapper = `${MARKER}\nfunction ${SPEED_NAME}(props){return props.agent==="claude"?${jsx}.jsx(${TOGGLE_NAME},props):props.agent==="codex"?${jsx}.jsx(${CODEX_NAME},props):null}\n`;
  let patched = replaceOnce(source, `function ${SPEED_NAME}(`, `${component}\n${wrapper}function ${CODEX_NAME}(`, 'Shared agent control dispatch');

  // Retain this field in the same catalog store which drives reasoning controls.
  const catalog = metadata.catalogReplacement;
  const frame = /serviceTier:([$\w]+)\.serviceTier,/.exec(catalog)?.[1];
  if (!frame) throw new compat.CompatibilityError('structure-mismatch', 'The verified catalog frame could not be identified');
  const withUltracode = catalog.replace(`serviceTier:${frame}.serviceTier,`, `ultracodeEnabled:${frame}.ultracodeEnabled,serviceTier:${frame}.serviceTier,`);
  patched = replaceOnce(patched, catalog, withUltracode, 'Preserve Ultracode state in catalog');

  // Both families now have an adjacent control; reserve equal compact width.
  const budget = metadata.budgetReplacement;
  const withBudget = budget.replace(/\(([$\w]+)==="codex"\?9:0\)/, '($1==="codex"||$1==="claude"?9:0)');
  if (withBudget === budget) throw new compat.CompatibilityError('structure-mismatch', 'The verified compact budget could not be extended');
  patched = replaceOnce(patched, budget, withBudget, 'Reserve compact width for Ultracode');
  return {
    source: patched,
    changes: ['Dispatch Codex speed and Claude Ultracode from the same layout controls', 'Preserve independent Ultracode state', 'Reserve compact space for the Claude toggle'],
    metadata: { ...metadata, controlFunction: SPEED_NAME, speedFunction: CODEX_NAME, ultracodeFunction: TOGGLE_NAME, unifiedCatalogReplacement: withUltracode, unifiedBudgetReplacement: withBudget },
  };
}

function patchUnifiedFrontend(source, options = {}) {
  const speedTemplate = options.speedTemplate ?? readTemplate('speed-picker.template.js');
  const toggleTemplate = options.ultracodeTemplate ?? readTemplate('ultracode-toggle.template.js');
  const speed = compat.patchFrontend(source, speedTemplate);
  const unified = applyUltracodeToSpeedPatched(speed.source, speed.metadata, toggleTemplate);
  return { ...unified, changes: [...speed.changes, ...unified.changes], evidence: speed.evidence };
}

module.exports = { MARKER, TOGGLE_MARKER, createUltracodeSource, applyUltracodeToSpeedPatched, patchUnifiedFrontend };
