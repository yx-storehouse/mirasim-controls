'use strict';

// Deliberately conservative: discover minifier names, then compare the complete
// critical functions against fingerprints of locally verified original builds.
// Nothing in this module reads files, executes application code, or installs a patch.
const crypto = require('node:crypto');
const ID = '[$A-Z_a-z][$\\w]*';
const MARKER = 'mirasim-speed-picker:';
const STANDARD_TIER = { id: 'standard', name: 'Standard', description: 'Use standard speed, overriding the Codex configuration default.' };
const TRUSTED = {
  // These fingerprints are shared by the independently verified 0.0.750 and
  // 0.0.761 original builds. They are NOT learned from a new installation.
  route: ['ae2e02ce0b398c01f052551d70ea353c4c6c0d856b2a9377763cbbcdc6518d20'],
  select: ['56dcded26668cd0f3c848dd939c4eb4fac036435781fa340b42037976c27ff57'],
  request: ['66d0ec3ae961168f24ef7d347baeb33c80007301593b096cbb099b23d72e4383'],
  context: ['be1f7604ab036f01d4cf8c51e96901b28e7fa3764911ec8b87525fe0a5e2cfe4'],
  provider: ['cf19e05db6c47c2a1d4b2f889a5294f24262cfc80df1c97311bf0046e54ae5a5'],
  effort: ['7c278610ed316db60d4b7f8138b814c020e481f0c591beb3a5fc507621b59036'],
};

class CompatibilityError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'CompatibilityError'; this.code = code; this.details = details; }
}
function fail(code, message, details) { throw new CompatibilityError(code, message, details); }
function escape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function regex(value) { return new RegExp(value.replaceAll('@ID', ID), 'g'); }
function only(source, expression, label) {
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) fail('structure-mismatch', `${label}: expected exactly one match, found ${matches.length}`, { label, matches: matches.length });
  return matches[0];
}
function once(source, before, after, label) {
  const start = source.indexOf(before);
  if (start < 0 || source.indexOf(before, start + before.length) >= 0) fail('structure-mismatch', `${label}: replacement anchor is missing or ambiguous`, { label });
  return source.slice(0, start) + after + source.slice(start + before.length);
}
function checkSource(source) {
  if (typeof source !== 'string') throw new TypeError('Application source must be a string');
  if (source.includes(MARKER)) fail('already-patched', 'Existing speed-picker patch detected; use its receipt or original backup.');
}

function tokens(source) {
  const result = [];
  let i = 0;
  const push = (type, value) => result.push({ type, value });
  function quoted(quote) {
    const start = i++;
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i++] === quote) { push('literal', source.slice(start, i)); return; }
    }
    fail('invalid-source', 'Unterminated quoted literal');
  }
  function template() {
    push('punct', '`'); i++;
    let start = i;
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i] === '`') { push('literal', source.slice(start, i)); push('punct', '`'); i++; return; }
      if (source[i] === '$' && source[i + 1] === '{') {
        push('literal', source.slice(start, i)); push('punct', '${'); i += 2;
        code(true); start = i; continue;
      }
      i++;
    }
    fail('invalid-source', 'Unterminated template literal');
  }
  function code(interpolation = false) {
    let braces = 0;
    while (i < source.length) {
      const c = source[i];
      if (/\s/.test(c)) { i++; continue; }
      if (source.startsWith('//', i)) { const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end + 1; continue; }
      if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); if (end < 0) fail('invalid-source', 'Unterminated comment'); i = end + 2; continue; }
      if (c === '"' || c === "'") { quoted(c); continue; }
      if (c === '`') { template(); continue; }
      if (interpolation && c === '}' && braces === 0) { push('punct', '}'); i++; return; }
      if (c === '{') braces++;
      if (c === '}') braces--;
      const identifier = /^[$A-Z_a-z][$\w]*/.exec(source.slice(i));
      if (identifier) { push('id', identifier[0]); i += identifier[0].length; continue; }
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(i));
      if (number) { push('literal', number[0]); i += number[0].length; continue; }
      const operator = /^(?:===|!==|>>>|\*\*|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\+=|-=|\*\=|\/\=|\.\.\.|<<|>>)/.exec(source.slice(i));
      push('punct', operator ? operator[0] : c); i += operator ? operator[0].length : 1;
    }
    if (interpolation) fail('invalid-source', 'Unterminated template expression');
  }
  code();
  return result;
}

const KEYWORDS = new Set(('function const let var if else return throw new typeof void null true false for of in while do break continue switch case default try catch finally async await yield class extends static get set delete this super instanceof import export from as with debugger').split(' '));
const BUILTINS = new Set(('Object Array String Number Boolean Math JSON Error TypeError Promise Set Map WeakMap WeakSet Date RegExp Symbol Intl BigInt Infinity NaN undefined window document globalThis console setTimeout clearTimeout requestAnimationFrame cancelAnimationFrame getComputedStyle').split(' '));
function structuralFingerprint(source) {
  const list = tokens(source), names = new Map();
  const normalized = list.map((token, i) => {
    if (token.type !== 'id') return `${token.type}:${token.value}`;
    const previous = list[i - 1]?.value, next = list[i + 1]?.value;
    // Dot properties and explicit object/destructuring keys are contracts, not
    // minifier names. Literal strings and every operator are always preserved.
    const property = previous === '.' || previous === '?.' || next === ':' && ['{', ','].includes(previous);
    if (property || KEYWORDS.has(token.value) || BUILTINS.has(token.value)) return `id:${token.value}`;
    if (!names.has(token.value)) names.set(token.value, `v${names.size}`);
    return `binding:${names.get(token.value)}`;
  });
  return crypto.createHash('sha256').update(normalized.join('\n')).digest('hex');
}

function balancedEnd(source, start, open, close) {
  let depth = 0, quote = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (source.startsWith('/*', i)) { i = source.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i + 2); if (i < 0) break; continue; }
    if (c === open) depth++;
    if (c === close && --depth === 0) return i + 1;
  }
  fail('invalid-source', `Unbalanced ${open}${close} expression`);
}
function extractFunction(source, name) {
  const match = only(source, new RegExp(`function ${escape(name)}\\(`, 'g'), `function ${name}`);
  const argsStart = match.index + match[0].length - 1;
  const argsEnd = balancedEnd(source, argsStart, '(', ')');
  if (source[argsEnd] !== '{') fail('structure-mismatch', `Unexpected function body: ${name}`);
  const end = balancedEnd(source, argsEnd, '{', '}');
  return source.slice(match.index, end);
}
function trusted(source, name, family, evidence) {
  const body = extractFunction(source, name);
  const fingerprint = structuralFingerprint(body);
  evidence.push({ family, function: name, fingerprint });
  if (!TRUSTED[family]?.includes(fingerprint)) fail('unverified-structure', `${family} function structure has changed; manual adaptation is required`, { family, function: name, fingerprint });
  return body;
}

function detectBackend(source) {
  checkSource(source);
  const override = only(source, regex(String.raw`function (?<override>@ID)\((?<argument>@ID)=\[\]\)\{if\(\k<argument>\["some"\]\((?<item>@ID)=>\k<item>\["trimStart"\]\(\)\["startsWith"\]\("service_tier="\)\)\)return null;let (?<tier>@ID)=(?<preference>@ID)\(\);return \k<tier>&&(?<catalog>@ID)\(\)\["some"\]\(\k<item>=>\k<item>\["id"\]===\k<tier>\)\?"service_tier="\+\k<tier>:null\}`), 'Codex service tier override');
  const spec = { ...override.groups, overrideBody: override[0] };
  const catalog = only(source, regex(String.raw`function ${escape(spec.catalog)}\(\)\{let (?<set>@ID)=new Set,(?<list>@ID)=\[\];for\(let (?<row>@ID) of Object\["values"\]\((?<models>@ID)\(\)\)\)for\(let (?<entry>@ID) of \k<row>\)\k<set>\["has"\]\(\k<entry>\["id"\]\)\|\|\(\k<set>\["add"\]\(\k<entry>\["id"\]\),\k<list>\["push"\]\(\k<entry>\)\);return \k<list>\}`), 'Codex service tier catalog');
  Object.assign(spec, catalog.groups, { catalogBody: catalog[0] });
  const preference = only(source, regex(String.raw`function ${escape(spec.preference)}\((?<configArg>@ID)=(?<config>@ID)\(\)\)\{let (?<value>@ID)=typeof \k<configArg>\["codexServiceTier"\]=="string"\?\k<configArg>\["codexServiceTier"\]\["trim"\]\(\):"";return \k<value>&&\k<value>\["toLowerCase"\]\(\)!=="default"\?\k<value>:null\}`), 'Codex persisted service tier');
  Object.assign(spec, preference.groups);
  only(source, regex(String.raw`(?<frame>@ID)\["serviceTier"\]!==void 0\)\{if\((?<agent>@ID)!=="codex"\)throw new Error\("serviceTier applies to codex only"\);let (?<value>@ID)=\k<frame>\["serviceTier"\]\["trim"\]\(\);(?<config>@ID)\["codexServiceTier"\]=\k<value>&&\k<value>\["toLowerCase"\]\(\)!=="default"\?\k<value>:void 0\}`), 'Codex service tier setter');
  only(source, regex(String.raw`\.\.\.@ID==="codex"\?\{"serviceTiers":${escape(spec.catalog)}\(\)\}:\{\}`), 'Codex catalog exposure');
  only(source, regex(String.raw`let (?<value>@ID)=${escape(spec.override)}\((?<args>@ID)\);return \k<value>&&\k<args>\["push"\]\(\k<value>\),\k<args>\}`), 'Codex runner override application');
  return { compatible: true, spec, evidence: [
    { family: 'backend-override', function: spec.override, fingerprint: structuralFingerprint(spec.overrideBody) },
    { family: 'backend-catalog', function: spec.catalog, fingerprint: structuralFingerprint(spec.catalogBody) },
    { family: 'backend-contract', checks: ['preference', 'setter', 'catalog-exposure', 'runner-application'] },
  ] };
}

function detectFrontend(source) {
  checkSource(source);
  const evidence = [];
  const imports = only(source, regex(String.raw`import\{(?<bindings>[^}]+)\}from"\./react-vendor-[^"]+\.js"`), 'React vendor import');
  const jsx = only(imports.groups.bindings, regex(String.raw`(?:^|,)j as (?<name>@ID)(?=,|$)`), 'JSX runtime binding').groups.name;
  const react = only(imports.groups.bindings, regex(String.raw`(?:^|,)r as (?<name>@ID)(?=,|$)`), 'React hooks binding').groups.name;
  const context = only(source, regex(String.raw`function (?<hook>@ID)\(\)\{const (?<value>@ID)=${escape(react)}\.useContext\((?<context>@ID)\);if\(!\k<value>\)throw new Error\("useWorkbenchHost must be used inside <Workbench> \(WorkbenchHostProvider\)"\);return \k<value>\}`), 'Workbench context hook');
  trusted(source, context.groups.hook, 'context', evidence);
  const provider = only(source, regex(String.raw`function (?<provider>@ID)\(\{value:(?<value>@ID),children:(?<children>@ID)\}\)\{return ${escape(jsx)}\.jsx\(${escape(context.groups.context)}\.Provider,\{value:\k<value>,children:\k<children>\}\)\}`), 'Workbench context provider');
  trusted(source, provider.groups.provider, 'provider', evidence);
  const catalog = only(source, regex(String.raw`case"catalog":(?<store>@ID)\.setState\((?<state>@ID)=>\(\{catalogs:\{\.\.\.\k<state>\.catalogs,\[(?<frame>@ID)\.agent\]:\{models:\k<frame>\.models,`), 'Composer catalog reducer');
  const request = only(source, regex(String.raw`function (?<request>@ID)\((?<client>@ID),(?<frame>@ID),(?<expected>@ID),(?<options>@ID)=\{\}\)\{const\{match:@ID,rejectOnError:@ID=!0,timeoutMs:@ID=15e3\}=\k<options>;return new Promise\(`), 'Acknowledged settings request');
  trusted(source, request.groups.request, 'request', evidence);
  const select = only(source, regex(String.raw`function (?<select>@ID)\(\{value:@ID,options:@ID,onChange:@ID,className:@ID,placeholder:@ID="—",disabled:@ID=!1,readOnly:@ID=!1,size:@ID="md",leading:@ID,mono:@ID=!1,variant:@ID="input",collapseWhenSingle:@ID=!0,align:@ID="start",valueContent:@ID,ariaLabel:@ID,menuMinWidth:@ID\}\)`), 'Native Select control');
  trusted(source, select.groups.select, 'select', evidence);
  const route = only(source, regex(String.raw`function (?<route>@ID)\(\{agent:(?<agent>@ID),agentLabel:@ID,model:(?<model>@ID),modelTitle:@ID,routeLeg:@ID,routeWord:@ID,routeProvider:@ID=!1,subscription:@ID=!1,workspace:(?<workspace>@ID),checkout:@ID,efforts:@ID,effort:@ID,onEffort:@ID,stripAnchorRef:@ID,open:@ID,onOpen:@ID,disabled:(?<disabled>@ID),tail:(?<tail>@ID),t:@ID\}\)`), 'Compact composer route');
  const routeBody = extractFunction(source, route.groups.route);
  if (/serviceTier|service_tier|speedTier|data-mirasim-speed-picker/.test(routeBody)) fail('native-speed-control', 'The composer already contains speed handling; manual review is required.');
  trusted(source, route.groups.route, 'route', evidence);
  const compact = only(routeBody, regex(String.raw`children:\[@ID,@ID\]\}\)\),${escape(route.groups.tail)},${escape(route.groups.workspace)}&&`), 'Compact speed insertion point');
  const budget = only(routeBody, regex(String.raw`(?<function>@ID)\(\{model:${escape(route.groups.model)},effort:@ID,budget:${escape(route.groups.tail)}\?(?<base>@ID)-(?<cost>@ID):\k<base>\}\)`), 'Compact text budget');
  const invocation = only(source, regex(String.raw`(?<sheet>@ID)&&${escape(jsx)}\.jsx\(${escape(route.groups.route)},\{agent:(?<agent>@ID),agentLabel:[\s\S]{1,1800}?efforts:(?<efforts>@ID),effort:(?<effort>@ID),onEffort:(?<onEffort>@ID),[\s\S]{1,1800}?disabled:!(?<agents>@ID)\.length,`), 'Compact composer invocation');
  const parent = invocation.groups;
  const layout = only(source, regex(String.raw`(?<layout>@ID)=(?<hook>@ID)\(\),${escape(parent.sheet)}=\k<layout>==="sheet"`), 'Composer layout guard');
  const desktop = only(source, regex(String.raw`${escape(jsx)}\.jsx\((?<effortControl>@ID),\{current:${escape(parent.effort)},options:${escape(parent.efforts)},onSelect:${escape(parent.onEffort)},label:(?<translate>@ID)\("hub.selectEffort"\),(?:t:\k<translate>|t)\}\)`), 'Desktop effort control');
  const effortBody = trusted(source, desktop.groups.effortControl, 'effort', evidence);
  if (!effortBody.includes(`${layout.groups.hook}()==="sheet"`)) fail('structure-mismatch', 'Desktop effort control no longer shares the compact layout guard.');
  // Locate the actual memoized InputComposer, rather than taking the nearest
  // preceding named function (which could be a nested helper after native UI).
  const composer = only(source, regex(String.raw`${escape(react)}\.memo\(function\(\{t,active:@ID,draftKey:@ID,placeholder:@ID,busy:@ID,backgroundBusy:@ID,stopping:@ID,sending:@ID,agents:${escape(parent.agents)},agent:${escape(parent.agent)},onAgent:@ID,onRefreshModels:@ID,models:@ID,model:@ID,onModel:@ID,efforts:${escape(parent.efforts)},effort:${escape(parent.effort)},onEffort:${escape(parent.onEffort)},`), 'Memoized input composer');
  const argsStart = source.indexOf('function(', composer.index) + 'function'.length;
  const argsEnd = balancedEnd(source, argsStart, '(', ')');
  if (source[argsEnd] !== '{') fail('structure-mismatch', 'Unexpected input composer body');
  const groupEnd = balancedEnd(source, argsEnd, '{', '}');
  if (!(argsEnd < invocation.index && invocation.index < groupEnd && argsEnd < desktop.index && desktop.index < groupEnd)) {
    fail('structure-mismatch', 'Compact and desktop controls are no longer in the same composer');
  }
  const composerSlice = source.slice(argsEnd, groupEnd);
  if (/serviceTier|service_tier|speedTier|data-mirasim-speed-picker/.test(composerSlice)) fail('native-speed-control', 'The desktop composer already contains speed handling; manual review is required.');
  const metadata = {
    componentName: 'MirasimSpeedPickerV1',
    symbols: { REACT: react, JSX: jsx, STORE: catalog.groups.store, CONTEXT: context.groups.hook, REQUEST: request.groups.request, SELECT: select.groups.select },
    contextVariable: context.groups.context, contextProvider: provider.groups.provider,
    routeFunction: route.groups.route,
    routeAnchor: compact[0],
    routeReplacement: compact[0].replace(`,${route.groups.tail},`, `,/* mirasim-speed-picker:compact */${jsx}.jsx(MirasimSpeedPickerV1,{agent:${route.groups.agent},disabled:${route.groups.disabled}}),${route.groups.tail},`),
    desktopAnchor: desktop[0],
    desktopReplacement: `${desktop[0]},/* mirasim-speed-picker:desktop */!${parent.sheet}&&${jsx}.jsx(MirasimSpeedPickerV1,{agent:${parent.agent},disabled:!${parent.agents}.length})`,
    catalogAnchor: catalog[0],
    catalogReplacement: catalog[0].replace(`models:${catalog.groups.frame}.models,`, `/* mirasim-speed-picker:catalog */serviceTier:${catalog.groups.frame}.serviceTier,serviceTiers:${catalog.groups.frame}.serviceTiers,models:${catalog.groups.frame}.models,`),
    budgetAnchor: budget[0],
    budgetReplacement: budget[0].replace(`budget:${route.groups.tail}?${budget.groups.base}-${budget.groups.cost}:${budget.groups.base}`, `budget:Math.max(8,(${route.groups.tail}?${budget.groups.base}-${budget.groups.cost}:${budget.groups.base})-(${route.groups.agent}==="codex"?9:0))`),
    sheetGuard: layout[0], routeGuard: `${parent.sheet}&&${jsx}.jsx(${route.groups.route},`,
  };
  evidence.push({ family: 'layout', checks: ['compact-desktop-exclusive', 'shared-effort-values', 'shared-layout-hook', 'unique-insertion-points'] });
  return { compatible: true, metadata, evidence };
}

function patchBackend(source) {
  const detected = detectBackend(source), s = detected.spec;
  const catalog = s.catalogBody.replace(`let ${s.set}=new Set,${s.list}=[];`, `/* mirasim-speed-picker:explicit-standard-v1 */let ${s.set}=new Set(["standard"]),${s.list}=[${JSON.stringify(STANDARD_TIER)}];`);
  const override = s.overrideBody.replace(`let ${s.tier}=${s.preference}();return`, `let ${s.tier}=${s.preference}();if(${s.tier}==="standard")return "service_tier=default";return`);
  let patched = once(source, s.catalogBody, catalog, 'service tier catalog');
  patched = once(patched, s.overrideBody, override, 'service tier override');
  return { source: patched, changes: ['Advertise explicit Standard tier', 'Map Standard to service_tier=default'], evidence: detected.evidence, metadata: s };
}
function patchFrontend(source, template) {
  if (typeof template !== 'string' || !template.includes('/* mirasim-speed-picker:v1 */')) throw new TypeError('A complete speed-picker template is required');
  const detected = detectFrontend(source), m = detected.metadata;
  let component = template;
  for (const [name, value] of Object.entries(m.symbols)) component = component.replaceAll(`__${name}__`, value);
  if (/__[A-Z]+__/.test(component)) fail('invalid-template', 'Unresolved template symbols');
  const edits = [
    [m.catalogAnchor, m.catalogReplacement, 'Preserve speed settings in composer catalog'],
    [m.routeAnchor, m.routeReplacement, 'Add compact speed picker'],
    [m.desktopAnchor, m.desktopReplacement, 'Add desktop speed picker'],
    [m.budgetAnchor, m.budgetReplacement, 'Reserve compact layout space'],
    [`function ${m.routeFunction}(`, `${component}\nfunction ${m.routeFunction}(`, 'Add native speed picker component'],
  ];
  let patched = source;
  for (const [before, after, label] of edits) patched = once(patched, before, after, label);
  return { source: patched, changes: edits.map(edit => edit[2]), evidence: detected.evidence, metadata: m };
}

module.exports = { CompatibilityError, detectBackend, detectFrontend, patchBackend, patchFrontend,
  structuralFingerprint, extractFunction };
