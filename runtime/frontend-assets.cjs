'use strict';
const fs = require('node:fs');
const path = require('node:path');
const compat = require('./compat.cjs');
const controls = require('./claude-controls-frontend.cjs');
const unified = require('./ultracode-frontend.cjs');

const ID = '[$A-Z_a-z][$\\w]*';
const TRUSTED = {
  route: [
    'ae2e02ce0b398c01f052551d70ea353c4c6c0d856b2a9377763cbbcdc6518d20',
    // 787 forwards an optional credit value to the native route badge.
    '438a769e3a73c362221abc0462c2c9d49c644eaacf00eafe1a8a5d8eca371214',
  ],
  select: '56dcded26668cd0f3c848dd939c4eb4fac036435781fa340b42037976c27ff57',
  request: [
    '66d0ec3ae961168f24ef7d347baeb33c80007301593b096cbb099b23d72e4383',
    // 787 adds an optional error-frame predicate; the omitted-option contract is unchanged.
    '773bb323b6c1ffffd243a437544c6bc0996156c779fdc6b8795c88c9db23b186',
  ],
  context: 'be1f7604ab036f01d4cf8c51e96901b28e7fa3764911ec8b87525fe0a5e2cfe4',
  provider: 'cf19e05db6c47c2a1d4b2f889a5294f24262cfc80df1c97311bf0046e54ae5a5',
  effort: '7c278610ed316db60d4b7f8138b814c020e481f0c591beb3a5fc507621b59036',
};
const MARKERS = ['mirasim-speed-picker:', 'mirasim-unified-controls:', 'mirasim-claude-controls:', 'mirasim-ultracode-toggle:', 'mirasim-claude-fast-toggle:'];
function fail(code, message, details) { throw new compat.CompatibilityError(code, message, details); }
function escape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function regex(pattern) { return new RegExp(pattern.replaceAll('@ID', ID), 'g'); }
function only(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) fail('split-structure-mismatch', `${label}: expected one match, found ${matches.length}`);
  return matches[0];
}
function replaceOnce(source, before, after, label) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) fail('split-structure-mismatch', `${label}: missing or ambiguous anchor`);
  return source.slice(0, at) + after + source.slice(at + before.length);
}
function trusted(source, name, family, ownerPath, evidence) {
  const body = compat.extractFunction(source, name);
  const fingerprint = compat.structuralFingerprint(body);
  const accepted = Array.isArray(TRUSTED[family]) ? TRUSTED[family] : [TRUSTED[family]];
  if (!accepted.includes(fingerprint)) fail('split-unverified-structure', `${family} function changed; manual adaptation is required`, { ownerPath, name, fingerprint });
  evidence.push({ family, function: name, ownerPath, fingerprint });
  return body;
}
function imports(source) {
  return [...source.matchAll(/import\{([^}]+)\}from"([^"]+)"/g)].map(match => ({
    source: match[2], bindings: match[1].split(',').map(part => {
      const parsed = new RegExp(`^(${ID})(?: as (${ID}))?$`).exec(part.trim());
      if (!parsed) fail('split-import-format', 'Unsupported named import binding');
      return { imported: parsed[1], local: parsed[2] || parsed[1] };
    }),
  }));
}
function reactBindings(source) {
  const found = imports(source).filter(item => /(?:^|\/)react-vendor-[^/]+\.js$/.test(item.source));
  if (found.length !== 1) fail('split-import-format', 'Expected one React vendor import');
  const one = imported => {
    const bindings = found[0].bindings.filter(item => item.imported === imported);
    if (bindings.length !== 1) fail('split-import-format', `Expected one React ${imported} binding`);
    return bindings[0].local;
  };
  return { react: one('r'), jsx: one('j') };
}
function exportedBindings(source) {
  const matches = [...source.matchAll(/export\{([^}]+)\};?\s*$/g)];
  if (matches.length !== 1) fail('split-export-format', 'Expected one final named export block');
  return matches[0][1].split(',').map(part => {
    const parsed = new RegExp(`^(${ID})(?: as (${ID}))?$`).exec(part.trim());
    if (!parsed) fail('split-export-format', 'Unsupported named export binding');
    return { local: parsed[1], exported: parsed[2] || parsed[1] };
  });
}
function resolveImport(inputPath, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(inputPath), specifier));
}
function linkedBinding(inputSource, inputPath, ownerSource, ownerPath, ownerLocal, evidence) {
  const exports = exportedBindings(ownerSource).filter(item => item.local === ownerLocal);
  if (exports.length !== 1) fail('split-link-mismatch', `Expected one export for ${ownerLocal}`);
  const candidates = imports(inputSource).filter(item => resolveImport(inputPath, item.source) === ownerPath)
    .flatMap(item => item.bindings).filter(item => item.imported === exports[0].exported);
  if (candidates.length !== 1) fail('split-link-mismatch', `Expected one import linked to ${ownerLocal}`);
  evidence.push({ family: 'module-link', ownerPath, ownerLocal, exported: exports[0].exported, inputPath, inputLocal: candidates[0].local });
  return candidates[0].local;
}
function balancedEnd(source, start, open, close) {
  let depth = 0, quote = null;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (source.startsWith('/*', i)) { i = source.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i + 2); if (i < 0) break; continue; }
    if (ch === open) depth++;
    if (ch === close && --depth === 0) return i + 1;
  }
  fail('split-invalid-source', 'Unbalanced source expression');
}

function normalizeAssets(assets) {
  if (!(assets instanceof Map)) throw new TypeError('Frontend assets must be a Map of paths to source strings');
  for (const [name, source] of assets) {
    if (typeof name !== 'string' || typeof source !== 'string') throw new TypeError('Asset paths and sources must be strings');
  }
  return assets;
}

function detectFrontendAssets(assets) {
  normalizeAssets(assets);
  const inputCandidates = [...assets].filter(([,source]) => source.includes('data-route-pick') && source.includes('hub.selectEffort'));
  const catalogCandidates = [...assets].filter(([,source]) => /case"catalog":[$\w]+\.setState\(/.test(source));
  if (inputCandidates.length !== 1 || catalogCandidates.length !== 1) fail('split-assets-ambiguous', 'Expected one input module and one catalog owner', { inputs: inputCandidates.map(x => x[0]), catalogs: catalogCandidates.map(x => x[0]) });
  const [inputPath, input] = inputCandidates[0], [catalogPath, owner] = catalogCandidates[0];
  for (const source of [input, owner]) if (MARKERS.some(marker => source.includes(marker))) fail('already-patched', 'Prepare controls from the verified original assets');
  if (inputPath === catalogPath) {
    const detected = compat.detectFrontend(input);
    return { compatible: true, paths: [inputPath], mode: 'single', metadata: { ...detected.metadata, inputPath, catalogPath }, evidence: detected.evidence };
  }

  const evidence = [], ui = reactBindings(input), shared = reactBindings(owner);
  const context = only(owner, regex(String.raw`function (?<hook>@ID)\(\)\{const (?<value>@ID)=${escape(shared.react)}\.useContext\((?<context>@ID)\);if\(!\k<value>\)throw new Error\("useWorkbenchHost must be used inside <Workbench> \(WorkbenchHostProvider\)"\);return \k<value>\}`), 'Shared Workbench context');
  trusted(owner, context.groups.hook, 'context', catalogPath, evidence);
  const provider = only(owner, regex(String.raw`function (?<provider>@ID)\(\{value:(?<value>@ID),children:(?<children>@ID)\}\)\{return ${escape(shared.jsx)}\.jsx\(${escape(context.groups.context)}\.Provider,\{value:\k<value>,children:\k<children>\}\)\}`), 'Shared Workbench provider');
  trusted(owner, provider.groups.provider, 'provider', catalogPath, evidence);
  const catalog = only(owner, regex(String.raw`case"catalog":(?<store>@ID)\.setState\((?<state>@ID)=>\(\{catalogs:\{\.\.\.\k<state>\.catalogs,\[(?<frame>@ID)\.agent\]:\{models:\k<frame>\.models,`), 'Shared catalog reducer');
  const request = only(owner, regex(String.raw`function (?<request>@ID)\((?<client>@ID),(?<frame>@ID),(?<expected>@ID),(?<options>@ID)=\{\}\)\{const\{match:@ID,rejectOnError:@ID=!0,(?:matchError:@ID,)?timeoutMs:@ID=15e3\}=\k<options>;return new Promise\(`), 'Shared acknowledged request');
  trusted(owner, request.groups.request, 'request', catalogPath, evidence);
  const select = only(owner, regex(String.raw`function (?<select>@ID)\(\{value:@ID,options:@ID,onChange:@ID,className:@ID,placeholder:@ID="—",disabled:@ID=!1,readOnly:@ID=!1,size:@ID="md",leading:@ID,mono:@ID=!1,variant:@ID="input",collapseWhenSingle:@ID=!0,align:@ID="start",valueContent:@ID,ariaLabel:@ID,menuMinWidth:@ID\}\)`), 'Shared Select');
  trusted(owner, select.groups.select, 'select', catalogPath, evidence);
  const linked = name => linkedBinding(input, inputPath, owner, catalogPath, name, evidence);
  const symbols = { REACT: ui.react, JSX: ui.jsx, STORE: linked(catalog.groups.store), CONTEXT: linked(context.groups.hook), REQUEST: linked(request.groups.request), SELECT: linked(select.groups.select) };
  const contextProvider = linked(provider.groups.provider);

  const route = only(input, regex(String.raw`function (?<route>@ID)\(\{agent:(?<agent>@ID),agentLabel:@ID,model:(?<model>@ID),modelTitle:@ID,routeLeg:@ID,routeWord:@ID,routeProvider:@ID=!1,subscription:@ID=!1,(?:credit:@ID=null,)?workspace:(?<workspace>@ID),checkout:@ID,efforts:@ID,effort:@ID,onEffort:@ID,stripAnchorRef:@ID,open:@ID,onOpen:@ID,disabled:(?<disabled>@ID),tail:(?<tail>@ID),t:@ID\}\)`), 'Split compact route');
  const routeBody = trusted(input, route.groups.route, 'route', inputPath, evidence);
  const compact = only(routeBody, regex(String.raw`children:\[@ID,@ID\]\}\)\),${escape(route.groups.tail)},${escape(route.groups.workspace)}&&`), 'Split compact insertion');
  const budget = only(routeBody, regex(String.raw`(?<function>@ID)\(\{model:${escape(route.groups.model)},effort:@ID,budget:${escape(route.groups.tail)}\?(?<base>@ID)-(?<cost>@ID):\k<base>\}\)`), 'Split compact budget');
  const invocation = only(input, regex(String.raw`(?<sheet>@ID)&&${escape(ui.jsx)}\.jsx\(${escape(route.groups.route)},\{agent:(?<agent>@ID),agentLabel:[\s\S]{1,1800}?efforts:(?<efforts>@ID),effort:(?<effort>@ID),onEffort:(?<onEffort>@ID),[\s\S]{1,1800}?disabled:!(?<agents>@ID)\.length,`), 'Split compact invocation');
  const parent = invocation.groups;
  const layout = only(input, regex(String.raw`(?<layout>@ID)=(?<hook>@ID)\(\),${escape(parent.sheet)}=\k<layout>==="sheet"`), 'Split layout guard');
  const desktop = only(input, regex(String.raw`${escape(ui.jsx)}\.jsx\((?<effortControl>@ID),\{current:${escape(parent.effort)},options:${escape(parent.efforts)},onSelect:${escape(parent.onEffort)},label:(?<translate>@ID)\("hub.selectEffort"\),(?:t:\k<translate>|t)\}\)`), 'Split desktop effort');
  const effortBody = trusted(input, desktop.groups.effortControl, 'effort', inputPath, evidence);
  if (!effortBody.includes(`${layout.groups.hook}()==="sheet"`)) fail('split-structure-mismatch', 'Desktop and compact layouts do not share their guard');
  const composer = only(input, regex(String.raw`${escape(ui.react)}\.memo\(function\(\{t(?::${escape(desktop.groups.translate)})?,active:@ID,draftKey:@ID,placeholder:@ID,busy:@ID,backgroundBusy:@ID,stopping:@ID,sending:@ID,agents:${escape(parent.agents)},agent:${escape(parent.agent)},onAgent:@ID,onRefreshModels:@ID,models:@ID,model:@ID,onModel:@ID,efforts:${escape(parent.efforts)},effort:${escape(parent.effort)},onEffort:${escape(parent.onEffort)},`), 'Split input composer');
  const argsStart = input.indexOf('function(', composer.index) + 'function'.length;
  const argsEnd = balancedEnd(input, argsStart, '(', ')');
  if (input[argsEnd] !== '{') fail('split-structure-mismatch', 'Unexpected split composer body');
  const end = balancedEnd(input, argsEnd, '{', '}');
  if (![invocation.index, desktop.index].every(at => at > argsEnd && at < end)) fail('split-structure-mismatch', 'Both layouts must belong to the same input composer');
  if (/serviceTier|service_tier|speedTier|fastMode|ultracodeEnabled|data-mirasim-/.test(routeBody + input.slice(argsEnd, end))) fail('native-speed-control', 'The split input composer already handles speed controls');
  const metadata = {
    inputPath, catalogPath, symbols, routeFunction: route.groups.route,
    contextProvider, contextProviderImported: contextProvider, contextVariable: null,
    contextOwner: { path: catalogPath, context: context.groups.context, provider: provider.groups.provider },
    routeAnchor: compact[0],
    routeReplacement: compact[0].replace(`,${route.groups.tail},`, `,/* mirasim-speed-picker:compact */${ui.jsx}.jsx(MirasimSpeedPickerV1,{agent:${route.groups.agent},disabled:${route.groups.disabled},compact:true}),${route.groups.tail},`),
    desktopAnchor: desktop[0],
    desktopReplacement: `${desktop[0]},/* mirasim-speed-picker:desktop */!${parent.sheet}&&${ui.jsx}.jsx(MirasimSpeedPickerV1,{agent:${parent.agent},disabled:!${parent.agents}.length})`,
    catalogAnchor: catalog[0],
    catalogReplacement: catalog[0].replace(`models:${catalog.groups.frame}.models,`, `/* mirasim-speed-picker:catalog */fastMode:${catalog.groups.frame}.fastMode,ultracodeEnabled:${catalog.groups.frame}.ultracodeEnabled,serviceTier:${catalog.groups.frame}.serviceTier,serviceTiers:${catalog.groups.frame}.serviceTiers,models:${catalog.groups.frame}.models,`),
    budgetAnchor: budget[0],
    budgetReplacement: budget[0].replace(`budget:${route.groups.tail}?${budget.groups.base}-${budget.groups.cost}:${budget.groups.base}`, `budget:Math.max(8,(${route.groups.tail}?${budget.groups.base}-${budget.groups.cost}:${budget.groups.base})-(${route.groups.agent}==="codex"?9:0))`),
    compactAgent: route.groups.agent,
    controlFunction: 'MirasimSpeedPickerV1', speedFunction: 'MirasimCodexSpeedPickerV3', ultracodeFunction: 'MirasimUltracodeToggleV1', fastFunction: 'MirasimClaudeFastToggleV4', queueFunction: 'MirasimClaudeSettingsRequestV4', claudeControlsFunction: 'MirasimClaudeControlsV4',
  };
  return { compatible: true, mode: 'split', paths: [inputPath, catalogPath], metadata, evidence };
}

function readTemplate(name) { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }
function resolvedTemplate(template, symbols) {
  for (const [key, value] of Object.entries(symbols)) template = template.replaceAll(`__${key}__`, value);
  if (/__[A-Z]+__/.test(template)) fail('invalid-template', 'Unresolved controls template binding');
  return template;
}
function patchFrontendAssets(assets, options = {}) {
  const detected = detectFrontendAssets(assets), m = detected.metadata;
  if (detected.mode === 'single') {
    const patched = controls.patchControlsFrontend(assets.get(m.inputPath), options);
    return { ...patched, mode: 'single', paths: detected.paths, metadata: { ...patched.metadata, inputPath: m.inputPath, catalogPath: m.catalogPath }, files: new Map([[m.inputPath, patched.source]]) };
  }
  let speed = resolvedTemplate(options.speedTemplate ?? readTemplate('speed-picker.template.js'), m.symbols);
  speed = replaceOnce(speed, 'function MirasimSpeedPickerV1(', 'function MirasimCodexSpeedPickerV3(', 'Name the preserved Codex component');
  let uc = unified.createUltracodeSource(m, options.ultracodeTemplate ?? readTemplate('ultracode-toggle.template.js'));
  uc = replaceOnce(uc, `await ${m.symbols.REQUEST}(client,`, 'await MirasimClaudeSettingsRequestV4(client,', 'Use serialized Claude settings writes');
  uc = replaceOnce(uc, '{ match: frame => frame.agent === "claude" });', '{ match: frame => frame.agent === "claude" && typeof frame.ultracodeEnabled === "boolean" && frame.ultracodeEnabled === next });', 'Validate the Ultracode acknowledgement');
  const fast = controls.createFastSource(m, options.fastTemplate ?? readTemplate('claude-fast-toggle.template.js'));
  const jsx = m.symbols.JSX;
  const group = `/* mirasim-claude-controls:v4 */\nfunction MirasimClaudeControlsV4(props){return ${jsx}.jsxs("div",{"data-mirasim-claude-controls":"v4",style:{display:"flex",alignItems:"center",gap:2,flexShrink:0,...props.compact?{flexBasis:"100%",width:"100%",order:99}:{}},children:[${jsx}.jsx(MirasimUltracodeToggleV1,props),${jsx}.jsx(MirasimClaudeFastToggleV4,props)]})}\n`;
  const wrapper = `/* mirasim-unified-controls:v3 */\nfunction MirasimSpeedPickerV1(props){return props.agent==="claude"?${jsx}.jsx(MirasimClaudeControlsV4,props):props.agent==="codex"?${jsx}.jsx(MirasimCodexSpeedPickerV3,props):null}\n`;
  let input = assets.get(m.inputPath);
  for (const [before, after, label] of [
    [m.routeAnchor, m.routeReplacement, 'Split compact control insertion'],
    [m.desktopAnchor, m.desktopReplacement, 'Split desktop control insertion'],
    [m.budgetAnchor, m.budgetReplacement, 'Split compact Codex budget'],
    [`function ${m.routeFunction}(`, `${speed}\n${uc}\n${fast}\n${group}${wrapper}function ${m.routeFunction}(`, 'Add controls using verified imported helpers'],
  ]) input = replaceOnce(input, before, after, label);
  const routeBefore = compat.extractFunction(input, m.routeFunction);
  const routeAfter = replaceOnce(routeBefore, 'className:"flex w-full items-stretch overflow-hidden text-fg-3",children:[', `className:"flex w-full items-stretch overflow-hidden text-fg-3",style:${m.compactAgent}==="claude"?{flexWrap:"wrap",rowGap:4}:void 0,children:[`, 'Split compact second control row');
  input = replaceOnce(input, routeBefore, routeAfter, 'Keep split compact Claude rows separate');
  const owner = replaceOnce(assets.get(m.catalogPath), m.catalogAnchor, m.catalogReplacement, 'Preserve all control fields in shared catalog owner');
  return { mode: 'split', paths: detected.paths, files: new Map([[m.inputPath, input], [m.catalogPath, owner]]), metadata: m, evidence: detected.evidence, changes: ['Patch verified split input module using existing named imports', 'Retain control fields in the separate catalog module', 'Preserve independent Fast/Ultracode controls and Codex speed behavior'] };
}

module.exports = { detectFrontendAssets, patchFrontendAssets };
