'use strict';
const fs = require('node:fs');
const path = require('node:path');
const compat = require('./compat.cjs');
const unified = require('./ultracode-frontend.cjs');

const MARKER = '/* mirasim-claude-controls:v4 */';
const FAST_MARKER = '/* mirasim-claude-fast-toggle:v1 */';
const FAST_NAME = 'MirasimClaudeFastToggleV4';
const GROUP_NAME = 'MirasimClaudeControlsV4';
const QUEUE_NAME = 'MirasimClaudeSettingsRequestV4';
const WRAPPER_NAME = 'MirasimSpeedPickerV1';
const CODEX_NAME = 'MirasimCodexSpeedPickerV3';
const ULTRACODE_NAME = 'MirasimUltracodeToggleV1';
const templateFile = name => fs.readFileSync(path.join(__dirname, name), 'utf8');

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new compat.CompatibilityError('structure-mismatch', `${label}: expected one matching anchor`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function createFastSource(metadata, template = templateFile('claude-fast-toggle.template.js')) {
  if (typeof template !== 'string' || !template.includes(FAST_MARKER)) throw new TypeError('A complete Claude Fast toggle template is required');
  for (const [key, value] of Object.entries(metadata.symbols)) template = template.replaceAll(`__${key}__`, value);
  if (/__[A-Z]+__/.test(template)) throw new compat.CompatibilityError('invalid-template', 'Unresolved Fast template symbol');
  return template;
}

function applyFastToUnified(source, metadata, fastTemplate) {
  if (typeof source !== 'string' || !metadata?.symbols?.JSX) throw new TypeError('Source and verified renderer metadata are required');
  if (source.includes(MARKER) || source.includes(FAST_MARKER)) throw new compat.CompatibilityError('already-patched', 'Claude Fast controls already exist; prepare from the original backup');
  if (!source.includes(unified.MARKER) || !source.includes(unified.TOGGLE_MARKER)) {
    throw new compat.CompatibilityError('structure-mismatch', 'A complete unified-controls candidate is required');
  }
  const jsx = metadata.symbols.JSX;
  const component = createFastSource(metadata, fastTemplate);
  const wrapper = `function ${WRAPPER_NAME}(props){return props.agent==="claude"?${jsx}.jsx(${ULTRACODE_NAME},props):props.agent==="codex"?${jsx}.jsx(${CODEX_NAME},props):null}`;
  const group = `${MARKER}\nfunction ${GROUP_NAME}(props){return ${jsx}.jsxs("div",{"data-mirasim-claude-controls":"v4",style:{display:"flex",alignItems:"center",gap:2,flexShrink:0,...props.compact?{flexBasis:"100%",width:"100%",order:99}:{}},children:[${jsx}.jsx(${ULTRACODE_NAME},props),${jsx}.jsx(${FAST_NAME},props)]})}\n`;
  const dispatch = wrapper.replace(`${jsx}.jsx(${ULTRACODE_NAME},props)`, `${jsx}.jsx(${GROUP_NAME},props)`);
  let patched = replaceOnce(source, wrapper, `${component}\n${group}${dispatch}`, 'Compose the independent Claude switches');

  const ucStart = patched.indexOf(unified.TOGGLE_MARKER);
  const ucEndMarker = '/* mirasim-ultracode-toggle:end */';
  const ucEnd = patched.indexOf(ucEndMarker, ucStart);
  if (ucStart < 0 || ucEnd < 0) throw new compat.CompatibilityError('structure-mismatch', 'The complete Ultracode component could not be identified');
  const ucBefore = patched.slice(ucStart, ucEnd + ucEndMarker.length);
  let ucAfter = replaceOnce(ucBefore, `await ${metadata.symbols.REQUEST}(client,`, `await ${QUEUE_NAME}(client,`, 'Serialize Claude settings replies');
  ucAfter = replaceOnce(ucAfter,
    '{ match: frame => frame.agent === "claude" });',
    '{ match: frame => frame.agent === "claude" && typeof frame.ultracodeEnabled === "boolean" && frame.ultracodeEnabled === next });',
    'Match Ultracode acknowledgement to the requested boolean');
  patched = replaceOnce(patched, ucBefore, ucAfter, 'Keep concurrent Claude switches independent');

  const catalog = metadata.unifiedCatalogReplacement;
  const frame = /ultracodeEnabled:([$\w]+)\.ultracodeEnabled,/.exec(catalog)?.[1];
  if (!frame) throw new compat.CompatibilityError('structure-mismatch', 'The unified catalog frame is missing');
  const withFast = catalog.replace(`ultracodeEnabled:${frame}.ultracodeEnabled,`, `fastMode:${frame}.fastMode,ultracodeEnabled:${frame}.ultracodeEnabled,`);
  patched = replaceOnce(patched, catalog, withFast, 'Preserve the independent Fast catalog value');

  // Compact Claude controls get a dedicated second row. This preserves the
  // model and reasoning selector at phone widths instead of truncating both.
  const invocation = metadata.routeReplacement;
  const compact = invocation.replace(/disabled:([$\w]+)\}/, 'disabled:$1,compact:true}');
  if (compact === invocation) throw new compat.CompatibilityError('structure-mismatch', 'Compact control invocation was not found');
  patched = replaceOnce(patched, invocation, compact, 'Mark the compact Claude control placement');
  const agent = /agent:([$\w]+),disabled:/.exec(invocation)?.[1];
  if (!agent) throw new compat.CompatibilityError('structure-mismatch', 'Compact route agent binding was not found');
  const routeBefore = compat.extractFunction(patched, metadata.routeFunction);
  const routeClass = 'className:"flex w-full items-stretch overflow-hidden text-fg-3",children:[';
  const routeWrapped = `className:"flex w-full items-stretch overflow-hidden text-fg-3",style:${agent}==="claude"?{flexWrap:"wrap",rowGap:4}:void 0,children:[`;
  const routeAfter = replaceOnce(routeBefore, routeClass, routeWrapped, 'Wrap compact Claude controls without changing Codex layout');
  patched = replaceOnce(patched, routeBefore, routeAfter, 'Place compact Claude controls on the second row');
  patched = replaceOnce(patched, metadata.unifiedBudgetReplacement, metadata.budgetReplacement, 'Restore the compact Claude model and effort budget');

  return {
    source: patched,
    changes: ['Add an independent Claude Fast ON/OFF switch', 'Serialize independent Claude toggle writes and validate matching acknowledgements', 'Keep Claude model and effort on the first compact row', 'Retain Codex speed controls unchanged'],
    metadata: { ...metadata, fastFunction: FAST_NAME, claudeControlsFunction: GROUP_NAME, queueFunction: QUEUE_NAME, controlsCatalogReplacement: withFast, compactControlsReplacement: compact, controlsBudgetReplacement: metadata.budgetReplacement },
  };
}

function patchControlsFrontend(source, options = {}) {
  const prepared = unified.patchUnifiedFrontend(source, options);
  const controls = applyFastToUnified(prepared.source, prepared.metadata, options.fastTemplate);
  return { ...controls, changes: [...prepared.changes, ...controls.changes], evidence: prepared.evidence };
}

module.exports = { MARKER, FAST_MARKER, createFastSource, applyFastToUnified, patchControlsFrontend };
