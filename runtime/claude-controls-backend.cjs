'use strict';

const { extractFunction, structuralFingerprint } = require('./compat.cjs');
const { detectUltracodeBackend } = require('./ultracode-backend.cjs');
const MARKER = 'mirasim-claude-controls:backend-v4';
const ID = '[$A-Z_a-z][$\\w]*';
const TRUSTED_FAST = {
  runner: 'cce6d683a32493b37c1ae03e7f38395672c7e8c20a4dd295a33dcc8283511f48',
  factory: 'e959c21b38ab71532605d68a63786a715e2fd48ab05942356e28352fbc4ca3d5',
  reader: 'd4a17e3eed24812bade5e4486bb84eca49ef82a7a27525d20ee84fe6ca230301',
  paths: 'ac3ed631afd98e8b708992606b5a85b3c72e754c1ee376053d6951ea29db1d7e',
  normalizer: '76b5e6c0936c2f61f624c898eb0ef55d72d64e011ad225a9caeda1cde50333a7',
  deepMerge: 'c9ce321361143a018f560da2768351015704283d674c5b286ddeca6244bbd9de',
};
const FAST_RESPONSIBILITIES = {
  runner: 'Native Claude command arguments',
  factory: 'Native Claude settings construction',
  reader: 'Native Fast preference reading',
  paths: 'Native global and project settings precedence',
  normalizer: 'Native command settings normalization',
  deepMerge: 'Native explicit settings merge precedence',
};

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function escape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function regex(pattern) { return new RegExp(pattern.replaceAll('@ID', ID), 'g'); }
function only(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) fail('claude-controls-structure-mismatch', `${label}: expected one match, found ${matches.length}`);
  return matches[0];
}
function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) fail('claude-controls-structure-mismatch', `${label}: missing or ambiguous anchor`);
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function detectClaudeControlsBackend(source) {
  if (typeof source !== 'string') throw new TypeError('Backend source must be a string');
  if (source.includes(MARKER) || source.includes('claudeFastEnabled')) {
    fail('claude-controls-already-present', 'Claude controls already exist; prepare from the verified original backup.');
  }
  const ultracode = detectUltracodeBackend(source);
  const runnerHead = only(source, regex(String.raw`function (?<name>@ID)\((?<executable>@ID),(?<input>@ID)\)\{let (?<args>@ID)=\["-p","--verbose","--output-format","stream-json","--include-partial-messages","--input-format","stream-json"\]`), 'Normal Claude stream-json runner');
  const runner = { ...runnerHead.groups, body: extractFunction(source, runnerHead.groups.name) };
  const factoryCall = only(runner.body, regex(String.raw`\.\.\.(?<factory>@ID)\(${escape(runner.input)}\["model"\],\{"userAutoCompactWindow":@ID\(${escape(runner.input)}\["workdir"\]\),"modelFallback":${escape(runner.input)}\["modelFallback"\]\?\?null,"fastMode":(?<reader>@ID)\(${escape(runner.input)}\["workdir"\]\)\}\)`), 'Native Fast configuration in runner');
  const factory = { name: factoryCall.groups.factory, body: extractFunction(source, factoryCall.groups.factory) };
  const reader = { name: factoryCall.groups.reader, body: extractFunction(source, factoryCall.groups.reader) };
  const readerPaths = only(reader.body, regex(String.raw`for\(let @ID of (?<paths>@ID)\(@ID,@ID\)\)`), 'Native global and project settings paths');
  const paths = { name: readerPaths.groups.paths, body: extractFunction(source, readerPaths.groups.paths) };
  const normalizerCall = only(runner.body, regex(String.raw`;let (?<result>@ID)=(?<normalizer>@ID)\(${escape(runner.args)}\);return `), 'Runner settings normalizer');
  const normalizer = { name: normalizerCall.groups.normalizer, body: extractFunction(source, normalizerCall.groups.normalizer) };
  const mergeCall = only(normalizer.body, regex(String.raw`\["reduce"\]\(\((?<left>@ID),(?<right>@ID)\)=>(?<merge>@ID)\(\k<left>,\k<right>\),\{\}\)`), 'Ordered settings merge');
  const deepMerge = { name: mergeCall.groups.merge, body: extractFunction(source, mergeCall.groups.merge) };
  const evidence = [...ultracode.evidence];
  for (const [family, item] of Object.entries({ runner, factory, reader, paths, normalizer, deepMerge })) {
    const fingerprint = structuralFingerprint(item.body);
    evidence.push({ family: `fast-${family}`, function: item.name, fingerprint });
    if (fingerprint !== TRUSTED_FAST[family]) {
      const responsibility = FAST_RESPONSIBILITIES[family];
      fail('claude-controls-unverified-structure', `${responsibility} (fast-${family}, ${item.name}) logic changed; manual adaptation is required`, {
        family, responsibility, fingerprint, function: item.name,
        expectedFingerprints: [TRUSTED_FAST[family]], actualFingerprint: fingerprint,
      });
    }
  }
  return { compatible: true, evidence, metadata: { ...ultracode.metadata, fast: { runner, factory, reader, paths, normalizer, deepMerge } } };
}

function patchClaudeControlsBackend(source) {
  const detected = detectClaudeControlsBackend(source), m = detected.metadata;
  const frame = m.setter.frame, agent = m.setter.agent;
  const validation = `for(const mirasimControlField of ["ultracodeEnabled","fastMode"]){if(${frame}[mirasimControlField]!==void 0){if(${agent}!=="claude")throw new Error(mirasimControlField+" applies to claude only");if(typeof ${frame}[mirasimControlField]!=="boolean")throw new Error(mirasimControlField+" must be boolean");}}`;
  let setter = m.setter.body.replace('{', `{/* ${MARKER} */${validation}`);
  const persistence = `if(${frame}["ultracodeEnabled"]!==void 0)${m.config.value}["claudeUltracodeEnabled"]=${frame}["ultracodeEnabled"];if(${frame}["fastMode"]!==void 0)${m.config.value}["claudeFastEnabled"]=${frame}["fastMode"];`;
  setter = replaceOnce(setter, m.configAnchor, m.configAnchor + persistence, 'Persist independent Claude control booleans');

  // An absent override keeps existing native settings. The catalog reports the
  // global native setting; per-project inheritance remains untouched until the
  // user deliberately saves an explicit global ON or OFF value.
  const defaultsFields = `"ultracodeEnabled":${m.defaults.value}["claudeUltracodeEnabled"]===true,"fastMode":typeof ${m.defaults.value}["claudeFastEnabled"]==="boolean"?${m.defaults.value}["claudeFastEnabled"]:${m.fast.reader.name}(void 0),`;
  const defaults = replaceOnce(m.defaults.body, m.defaultsAnchor, m.defaultsAnchor.replace('"accessMode":', defaultsFields + '"accessMode":'), 'Expose native Fast fallback and independent Ultracode state');
  const catalogFields = `"ultracodeEnabled":${m.catalog.persisted}?.["ultracodeEnabled"]===true,"fastMode":${m.catalog.persisted}?.["fastMode"]===true,`;
  const catalog = replaceOnce(m.catalog.body, m.catalogAnchor, m.catalogAnchor.replace('"outputStyles":', catalogFields + '"outputStyles":'), 'Expose both Claude controls in catalog');
  const forwarding = `"ultracodeEnabled":${m.routerFrame}["ultracodeEnabled"],"fastMode":${m.routerFrame}["fastMode"],`;
  const router = replaceOnce(m.routerBody, m.routerAnchor, m.routerAnchor + forwarding, 'Forward both independent control fields');

  const p = m.plugin;
  const plugin = `function ${p.name}(${p.enabled}){return{"id":"mirasim-claude-workflow","contributeSpawn":async({agent:${p.agent},mode:${p.mode},effort:${p.effort}})=>{if(${p.agent}!=="claude"||${p.mode}!=="run")return null;const mirasimLegacyWorkflow=await ${p.enabled}(${p.effort}??null),mirasimControlConfig=${m.config.read}(),mirasimClaudeArgs=[],mirasimClaudeEnv=mirasimLegacyWorkflow?{"CLAUDE_WORKFLOW":"1"}:{};if(typeof mirasimControlConfig["claudeFastEnabled"]==="boolean")mirasimClaudeArgs.push("--settings",JSON.stringify({fastMode:mirasimControlConfig["claudeFastEnabled"]}));if(mirasimControlConfig["claudeUltracodeEnabled"]===true){mirasimClaudeArgs.push("--effort","ultracode");mirasimClaudeEnv["CLAUDE_WORKFLOW"]="1";let mirasimSelectedEffort=typeof ${p.effort}==="string"?${p.effort}.trim().toLowerCase():"";if(mirasimSelectedEffort==="ultra")mirasimSelectedEffort="max";if(["low","medium","high","xhigh","max"].includes(mirasimSelectedEffort))mirasimClaudeEnv["CLAUDE_CODE_EFFORT_LEVEL"]=mirasimSelectedEffort;}return mirasimClaudeArgs.length||Object.keys(mirasimClaudeEnv).length?{...(mirasimClaudeArgs.length?{extraArgs:mirasimClaudeArgs}:{}),...(Object.keys(mirasimClaudeEnv).length?{env:mirasimClaudeEnv}:{})}:null}}}`;
  const edits = [
    [m.setter.body, setter, 'Validate and persist Fast and Ultracode independently'],
    [m.defaults.body, defaults, 'Preserve existing native Fast mode before the first explicit selection'],
    [m.catalog.body, catalog, 'Expose both Claude control booleans'],
    [m.routerBody, router, 'Forward both Claude controls through the native protocol'],
    [m.plugin.body, plugin, 'Apply explicit Fast ON/OFF while preserving independent Ultracode and effort'],
  ];
  for (const [before, after, label] of edits) source = replaceOnce(source, before, after, label);
  return { source, changes: edits.map(edit => edit[2]), evidence: detected.evidence, metadata: m };
}

module.exports = { MARKER, detectClaudeControlsBackend, patchClaudeControlsBackend };
