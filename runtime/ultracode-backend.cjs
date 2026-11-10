'use strict';

const { extractFunction, structuralFingerprint } = require('./compat.cjs');
const MARKER = 'mirasim-ultracode:backend-v1';
const ID = '[$A-Z_a-z][$\\w]*';
const TRUSTED = {
  setter: ['a19b6ec7909b86d5f5033c99fd1de373c51d785267a901fd69dc423cbf0c63cd'],
  defaults: ['b2e434e59e439fd87e9d8c20e71473ce1736892e71d5d4f021e8ea8e0f623ed8'],
  catalog: [
    '8a3fa6e0a68f47123303ddcec42528470c3ae77b2e7a3011e585b404f7a377b0',
    // 0.0.774 adds only Kimi default-model normalization. Removing that
    // independent branch yields the original catalog fingerprint above.
    '342ea10811ebf91914b99ded4857a75929b686c9be1f3acc659224e253ad7328',
    // 0.0.787 removes only the Antigravity thinkingText:"none" branch,
    // enabling its native thinking-display preference. Removing that branch
    // from 0.0.785 yields this exact hash; keep the native omission intact.
    '29112e6b013b3f9fb1d10910a1cc1fa14fe4e29f4a86b62ccf56c037ac5012d5',
  ],
  plugin: ['4e821bcbc2acaaba4188a75210005ccebd700bf4d8586f9c121e1e11211bf227'],
  fingerprint: [
    '989148ceac68c71eed725ff959e26012269f725c3d898580c25b88df0d1e5411',
    // 0.0.785 also includes non-empty runAs.wrap in the executable identity.
    // Removing only that JSON-serialized wrapper suffix yields the old hash;
    // effort, extraArgs and sorted env remain unchanged. Keep it verbatim so
    // wrapped and unwrapped native runners cannot share a pooled process.
    '39b00d0525b0b079e45425abfceee4459d35ac985abfcf9bd997f2e9945bc53e',
  ],
  normalizer: ['a98958739e3a04b3055ed8411cc0e08098c54f32622352522744509f4d065280'],
  // 0.0.771 adds actor/envKeys/path provenance to the return value. Its
  // environment and argument merge remain immutable, ordered, and unchanged.
  merge: ['b109e8c1023f6b376a3de8b0edb98902dc7483b0575ae9db5af4eca5cfe579c8',
    '9a1a677a0808c42ba20df2a7d6bdab4e4552fd92cddc5bdba6f984040cb8ef5d'],
};
const RESPONSIBILITIES = {
  setter: 'Agent defaults validation and persistence',
  defaults: 'Persisted agent defaults reader',
  catalog: 'Model catalog and control fields',
  plugin: 'Claude Workflow spawn contribution',
  fingerprint: 'Claude runner reuse identity',
  normalizer: 'Runner identity argument normalization',
  merge: 'Per-turn spawn arguments and environment merge',
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
  if (matches.length !== 1) fail('ultracode-structure-mismatch', `${label}: expected one match, found ${matches.length}`);
  return matches[0];
}
function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) !== -1) fail('ultracode-structure-mismatch', `${label}: missing or ambiguous anchor`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function detectUltracodeBackend(source) {
  if (typeof source !== 'string') throw new TypeError('Backend source must be a string');
  if (source.includes(MARKER) || source.includes('claudeUltracodeEnabled') || source.includes('ultracodeEnabled')) {
    fail('ultracode-already-present', 'Ultracode handling is already present; restore the known original before applying this adapter.');
  }
  const point = source.indexOf('serviceTier applies to codex only');
  if (point < 0) fail('ultracode-structure-mismatch', 'Native settings setter was not found');
  const setterStart = source.lastIndexOf('function ', point);
  const setterHead = /^function ([$\w]+)\(([$\w]+),([$\w]+)\)\{/.exec(source.slice(setterStart));
  if (!setterHead) fail('ultracode-structure-mismatch', 'Unexpected settings setter signature');
  const setter = { name: setterHead[1], agent: setterHead[2], frame: setterHead[3] };
  setter.body = extractFunction(source, setter.name);
  if (!setter.body.includes('serviceTier applies to codex only')) fail('ultracode-structure-mismatch', 'Wrong settings setter owner');
  const config = only(setter.body, regex(String.raw`let (?<value>@ID)=\{\.\.\.(?<read>@ID)\(\)\},\{model:(?<model>@ID),effort:(?<effort>@ID)\}=(?<keys>@ID)\[${escape(setter.agent)}\];`), 'Settings configuration clone');
  const defaultsHead = only(source, regex(String.raw`function (?<name>@ID)\((?<agent>@ID)\)\{if\(!@ID\["has"\]\(\k<agent>\)\)return null;let (?<value>@ID)=${escape(config.groups.read)}\(\),`), 'Persisted defaults reader');
  const defaults = { ...defaultsHead.groups };
  defaults.body = extractFunction(source, defaults.name);
  const defaultsAccess = only(defaults.body, regex(String.raw`\.\.\.${escape(defaults.agent)}==="claude"\?\{"accessMode":(?<access>@ID)\(${escape(defaults.value)}\)\}:\{\}`), 'Claude persisted settings');
  const catalogHead = only(source, regex(String.raw`function (?<name>@ID)\((?<agent>@ID),(?<deps>@ID)\)\{let @ID=@ID\(\k<agent>\),(?<persisted>@ID)=\k<deps>\["persistedAgentDefaults"\]\(\k<agent>\),`), 'Model catalog reader');
  const catalog = { ...catalogHead.groups };
  catalog.body = extractFunction(source, catalog.name);
  const catalogAccess = only(catalog.body, regex(String.raw`\.\.\.${escape(catalog.agent)}==="claude"\?\{"outputStyles":await @ID\(\)\}:\{\}`), 'Claude catalog controls');
  const router = only(source, regex(String.raw`case"setAgentDefaults":\{let @ID=this\["host"\]\["setAgentDefaults"\]\((?<frame>@ID)\["agent"\],\{[^{}]{50,2400}?\}\);`), 'Native settings protocol forwarding');
  const routerAnchor = `"serviceTier":${router.groups.frame}["serviceTier"],`;
  only(router[0], new RegExp(escape(routerAnchor), 'g'), 'Settings service tier forwarding');
  const pluginHead = only(source, regex(String.raw`function (?<name>@ID)\((?<enabled>@ID)\)\{return\{"id":"mirasim-claude-workflow","contributeSpawn":async\(\{agent:(?<agent>@ID),mode:(?<mode>@ID),effort:(?<effort>@ID)\}\)=>\k<agent>!=="claude"\|\|\k<mode>!=="run"\?null:await \k<enabled>\(\k<effort>\?\?null\)\?\{"env":\{"CLAUDE_WORKFLOW":"1"\}\}:null\}\}`), 'Claude Workflow spawn plugin');
  const plugin = { ...pluginHead.groups, body: pluginHead[0] };
  const fingerprintHead = only(source, regex(String.raw`function (?<name>@ID)\((?<executable>@ID),(?<input>@ID)\)\{let @ID=\k<input>\["runAs"\]&&\k<input>\["runAs"\]\["refuse"\]===void 0\?\k<input>\["runAs"\]:null;return JSON\["stringify"\]\(`), 'Claude runner fingerprint');
  const fingerprint = { ...fingerprintHead.groups };
  fingerprint.body = extractFunction(source, fingerprint.name);
  const normalized = only(fingerprint.body, regex(String.raw`(?<name>@ID)\(${escape(fingerprint.input)}\["extraArgs"\]\),Object\["entries"\]\(${escape(fingerprint.input)}\["env"\]\?\?\{\}\)\["sort"\]`), 'Runner arguments and environment identity');
  const normalizer = { name: normalized.groups.name, body: extractFunction(source, normalized.groups.name) };
  const mergeCall = only(source, regex(String.raw`(?<name>@ID)\(\[\{"env":(?<profile>@ID)\?\.\["env"\],"extraArgs":\k<profile>\?\.\["extraArgs"\],"configOverrides":\k<profile>\?\.\["configOverrides"\]\},\{"env":@ID\["env"\]\},\.\.\.@ID\]\)`), 'Fresh per-turn spawn merge');
  const merge = { name: mergeCall.groups.name, body: extractFunction(source, mergeCall.groups.name) };
  const evidence = [];
  for (const [family, item] of Object.entries({ setter, defaults, catalog, plugin, fingerprint, normalizer, merge })) {
    const hash = structuralFingerprint(item.body);
    evidence.push({ family, function: item.name, fingerprint: hash });
    if (!TRUSTED[family]?.includes(hash)) {
      const responsibility = RESPONSIBILITIES[family];
      fail('ultracode-unverified-structure', `${responsibility} (${family}, ${item.name}) logic changed; manual adaptation is required`, {
        family, responsibility, function: item.name, fingerprint: hash,
        expectedFingerprints: [...(TRUSTED[family] || [])], actualFingerprint: hash,
      });
    }
  }
  return { compatible: true, evidence, metadata: { setter, config: config.groups, configAnchor: config[0], defaults, defaultsAnchor: defaultsAccess[0], catalog, catalogAnchor: catalogAccess[0], routerBody: router[0], routerAnchor, routerFrame: router.groups.frame, plugin, fingerprint, normalizer, merge } };
}

function patchUltracodeBackend(source) {
  const detected = detectUltracodeBackend(source);
  const m = detected.metadata;
  const f = m.setter.frame, a = m.setter.agent;
  const validation = `if(${f}["ultracodeEnabled"]!==void 0){if(${a}!=="claude")throw new Error("ultracodeEnabled applies to claude only");if(typeof ${f}["ultracodeEnabled"]!=="boolean")throw new Error("ultracodeEnabled must be boolean");}`;
  let setter = m.setter.body.replace('{', `{/* ${MARKER} */${validation}`);
  setter = replaceOnce(setter, m.configAnchor, m.configAnchor + `if(${f}["ultracodeEnabled"]!==void 0)${m.config.value}["claudeUltracodeEnabled"]=${f}["ultracodeEnabled"];`, 'Persist independent Ultracode setting');
  const defaults = replaceOnce(m.defaults.body, m.defaultsAnchor, m.defaultsAnchor.replace('"accessMode":', `"ultracodeEnabled":${m.defaults.value}["claudeUltracodeEnabled"]===true,"accessMode":`), 'Expose persisted Ultracode setting');
  const catalog = replaceOnce(m.catalog.body, m.catalogAnchor, m.catalogAnchor.replace('"outputStyles":', `"ultracodeEnabled":${m.catalog.persisted}?.["ultracodeEnabled"]===true,"outputStyles":`), 'Expose Ultracode in Claude catalog');
  const router = replaceOnce(m.routerBody, m.routerAnchor, m.routerAnchor + `"ultracodeEnabled":${m.routerFrame}["ultracodeEnabled"],`, 'Forward independent Ultracode setting');
  const p = m.plugin;
  const plugin = `function ${p.name}(${p.enabled}){return{"id":"mirasim-claude-workflow","contributeSpawn":async({agent:${p.agent},mode:${p.mode},effort:${p.effort}})=>{if(${p.agent}!=="claude"||${p.mode}!=="run")return null;const mirasimLegacyWorkflow=await ${p.enabled}(${p.effort}??null);if(${m.config.read}()["claudeUltracodeEnabled"]!==true)return mirasimLegacyWorkflow?{"env":{"CLAUDE_WORKFLOW":"1"}}:null;let mirasimSelectedEffort=typeof ${p.effort}==="string"?${p.effort}.trim().toLowerCase():"";if(mirasimSelectedEffort==="ultra")mirasimSelectedEffort="max";const mirasimUltracodeEnv={"CLAUDE_WORKFLOW":"1"};if(["low","medium","high","xhigh","max"].includes(mirasimSelectedEffort))mirasimUltracodeEnv["CLAUDE_CODE_EFFORT_LEVEL"]=mirasimSelectedEffort;return{"extraArgs":["--effort","ultracode"],"env":mirasimUltracodeEnv}}}}`;
  const edits = [
    [m.setter.body, setter, 'Persist and validate independent Claude Ultracode boolean'],
    [m.defaults.body, defaults, 'Expose Ultracode state in settings acknowledgment'],
    [m.catalog.body, catalog, 'Expose Ultracode state in model catalog'],
    [m.routerBody, router, 'Forward Ultracode state from the UI protocol'],
    [m.plugin.body, plugin, 'Launch native Ultracode with the selected reasoning effort'],
  ];
  for (const [before, after, label] of edits) source = replaceOnce(source, before, after, label);
  return { source, changes: edits.map(item => item[2]), evidence: detected.evidence, metadata: m };
}

module.exports = { MARKER, detectUltracodeBackend, patchUltracodeBackend };
