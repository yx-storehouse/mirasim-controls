'use strict';

const { extractFunction, structuralFingerprint } = require('./compat.cjs');
const { detectUltracodeBackend } = require('./ultracode-backend.cjs');
const MARKER = 'mirasim-claude-controls:backend-v4';
const NATIVE_AUTH_MARKER = 'mirasim-claude-controls:native-api-auth-v1';
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

// These are source fingerprints, not values learned from the installation being
// patched. 750--792 share the first BYOK adapter; 824--828 add inline-tool defaults.
// 830 additionally supplies the native nonessential-traffic default. Its binding
// and literal value are checked separately below; this patch preserves that flag.
// The sealed credential, raw proxy and header-replacement contracts are identical
// across those reviewed builds. Never change generic OAuth or proxy auth globally.
const NATIVE_TRAFFIC_BYOK = 'f917061470703c1c16d0a945ed82dc41211c44b5cadeefee42f44325851d97e9';
const NATIVE_TRAFFIC_DEFAULTS = '0a2caaa8e7bf96ca46842b1a5e541bbaf252694ba544f207ceb34d73f8fd2a8d';
const TRUSTED_NATIVE_AUTH = {
  byok: ['6709d34d2239b74ad4f3796d224d8325d4e89225508d61de3976b19a4ce53f90',
    '5ce097d912732d97dba70796d09bca525420b4e8d3f35e9be775c5df686e70d3', NATIVE_TRAFFIC_BYOK],
  credentials: ['269811bd1ccfc6ed7d9187ac62b94555f93d71b51247be6aac3b5726773176f0'],
  auth: ['1ae60d8f22d8204108bb80cf76c74481ea93b2c348507b30f487dafbae176d6e'],
  sealed: ['9606fa937f692bb3f509df37f58963b5118436943234a73fa4d98bf686f1899f'],
  direct: ['8fd0652ed069280fa4fa44b7c9496a7832f9a812468835fb31625af9a052fbe2'],
  register: ['8e7bb7dafad7ba1ae3f63e8b7a287b843785fe26e35a9f4c7b49e7271e8f7315'],
  server: ['ff3fb5a04c5c9e77d10380e98e6ebdaa7a8df9853fdef1c7a6f23fb0ebcd9580'],
  proxy: ['6858e6fcf09c46b8e849cce027b27e1f7afd1d05bf0189c5eb6aee1118e7376e'],
  headers: ['c08bb7dc6c6b995d3ab69b3842f6542f78ed05fd177fe7264d2d94f5e78d1800'],
  drop: ['40b4a3a3f614e0962ad769492b5a19811032a4d608d3be7e141c39611cd254b2'],
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

function detectClaudeNativeApiAuth(source) {
  if (typeof source !== 'string') throw new TypeError('Backend source must be a string');
  if (source.includes(NATIVE_AUTH_MARKER)) fail('claude-controls-already-present', 'Native Claude API authentication is already patched.');
  const head = only(source, regex(String.raw`(?<name>@ID)=async\((?<provider>@ID),(?<profile>@ID),(?<credential>@ID),(?<options>@ID)\)=>\{if\(!(?<supported>@ID)\("claude",\k<provider>\)\)return\{\.\.\.(?<empty>@ID),"detail":"Claude BYOK needs an Anthropic`), 'Claude BYOK adapter');
  const args = ['provider', 'profile', 'credential', 'options'].map(key => head.groups[key]).join(',');
  const syntheticHead = `function __mirasimNativeByok(${args})`;
  const blockStart = source.indexOf('{', head.index);
  const normalized = extractFunction(syntheticHead + source.slice(blockStart), '__mirasimNativeByok');
  const byok = { ...head.groups, normalized, body: source.slice(head.index, blockStart) + normalized.slice(syntheticHead.length) };
  const p = escape(byok.provider), c = escape(byok.credential);
  const native = only(byok.body, regex(String.raw`let (?<base>@ID)=(?<baseURL>@ID)\(${p}\),(?<env>@ID)=\{"ANTHROPIC_BASE_URL":await ${c}\["direct"\]\(\k<base>\),\.\.\.(?<credentials>@ID)\(${c}\["value"\],(?<auth>@ID)\(${p}\)\)`), 'Native Claude BYOK credentials');
  const item = name => ({ name, body: extractFunction(source, name) });
  const credentials = item(native.groups.credentials), auth = item(native.groups.auth);
  const sealedHead = only(source, regex(String.raw`function (?<name>@ID)\((?<key>@ID)\)\{return\{"value":(?<value>@ID),"plain":false,"direct":(?<url>@ID)=>(?<direct>@ID)\(\k<url>,\k<key>\),"bridgeToken":(?<bridgeURL>@ID)=>(?<bridge>@ID)\(\k<bridgeURL>,\k<key>\)\}\}`), 'Sealed BYOK credential factory');
  const sealed = { ...sealedHead.groups, body: sealedHead[0] }, direct = item(sealed.direct);
  const directCalls = only(direct.body, regex(String.raw`await (?<server>@ID)\(\)\+(?<prefix>@ID)\(\)\+"/k/"\+(?<register>@ID)\(`), 'Sealed native proxy route');
  const register = item(directCalls.groups.register), server = item(directCalls.groups.server);
  const proxyCall = only(server.body, regex(String.raw`\["createServer"\]\(\((?<request>@ID),(?<response>@ID)\)=>\{(?<proxy>@ID)\(\k<request>,\k<response>\)`), 'Sealed native proxy handler');
  const proxy = item(proxyCall.groups.proxy);
  const headersCall = only(proxy.body, regex(String.raw`"headers":(?<headers>@ID)\(@ID\["headers"\],@ID\["apiKey"\]\)`), 'Sealed proxy credential replacement');
  const headers = item(headersCall.groups.headers);
  const dropName = only(headers.body, regex(String.raw`\|\|(?<name>@ID)\["has"\]\(`), 'Sealed proxy discarded headers').groups.name;
  const drop = { name: dropName, body: only(source, new RegExp(`${escape(dropName)}=new Set\\(\\[[^\\]]*\\]\\)`, 'g'), 'Sealed proxy discarded-header set')[0] };
  const metadata = { byok, native: native.groups, credentials, auth, sealed, direct, register, server, proxy, headers, drop };
  const evidence = [];
  for (const [family, expected] of Object.entries(TRUSTED_NATIVE_AUTH)) {
    const entry = metadata[family], fingerprint = structuralFingerprint(entry.normalized || entry.body);
    evidence.push({ family: `native-auth-${family}`, function: entry.name, fingerprint });
    if (!expected.includes(fingerprint)) fail('claude-controls-unverified-structure', `Native Claude API authentication (${family}, ${entry.name}) logic changed; manual adaptation is required`, {
      family: `native-auth-${family}`, responsibility: 'Native Claude BYOK authentication and sealed proxy contract',
      function: entry.name, expectedFingerprints: expected, actualFingerprint: fingerprint, fingerprint,
    });
  }
  if (structuralFingerprint(byok.normalized) === NATIVE_TRAFFIC_BYOK) {
    const defaultsName = only(byok.body, regex(String.raw`Object\["assign"\]\(${escape(native.groups.env)},@ID\(${escape(byok.profile)}\["modelId"\]\),@ID,@ID,(?<defaults>@ID)\)`), 'Native Claude traffic-default binding').groups.defaults;
    const defaults = { name: defaultsName, body: only(source,
      new RegExp(`(?<![$\\w])${escape(defaultsName)}=\\{[^{}]*\\}`, 'g'), 'Native Claude traffic-default constant')[0] };
    const fingerprint = structuralFingerprint(defaults.body);
    if (fingerprint !== NATIVE_TRAFFIC_DEFAULTS) fail('claude-controls-unverified-structure', 'Native Claude traffic defaults changed; manual adaptation is required', {
      family: 'native-auth-trafficDefaults', responsibility: 'Native Claude nonessential-traffic default',
      function: defaultsName, expectedFingerprints: [NATIVE_TRAFFIC_DEFAULTS], actualFingerprint: fingerprint, fingerprint,
    });
    metadata.trafficDefaults = defaults;
    evidence.push({ family: 'native-auth-trafficDefaults', function: defaultsName, fingerprint });
  }
  return { compatible: true, metadata, evidence };
}

function patchedNativeApiAuth(metadata) {
  const { byok, native, auth } = metadata, c = byok.credential, e = native.env;
  // This branch has already selected native Anthropic BYOK. Reuse its existing
  // sealed proxy credential so the CLI selects API-key semantics even when the
  // user also has a personal OAuth login. Keep explicit bearer-only providers,
  // unsealed credentials, bridges and absent credentials on their original path.
  const guard = `${byok.provider}["kind"]==="anthropic"&&${c}["plain"]===false&&typeof ${c}["value"]==="string"&&${c}["value"].trim()&&["unknown","x-api-key"].includes(${auth.name}(${byok.provider}))&&${e}["ANTHROPIC_AUTH_TOKEN"]===${c}["value"]&&${e}["ANTHROPIC_API_KEY"]===""`;
  const change = `/* ${NATIVE_AUTH_MARKER} */if(${guard}){${e}["ANTHROPIC_API_KEY"]=${c}["value"];${e}["ANTHROPIC_AUTH_TOKEN"]="";}`;
  const anchor = only(byok.body, regex(String.raw`\};return @ID\(${escape(native.base)}\)\|\|`), 'Native Claude BYOK environment completion')[0];
  return replaceOnce(byok.body, anchor, anchor.replace('};return ', `};${change}return `), 'Select API-key semantics for sealed native Claude BYOK');
}

function patchClaudeNativeApiAuth(source) {
  const detected = detectClaudeNativeApiAuth(source);
  return { source: replaceOnce(source, detected.metadata.byok.body, patchedNativeApiAuth(detected.metadata), 'Native Claude BYOK authentication'),
    changes: ['Use API-key semantics for existing sealed native Claude BYOK credentials'], ...detected };
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
  const nativeApiAuth = detectClaudeNativeApiAuth(source);
  const evidence = [...ultracode.evidence, ...nativeApiAuth.evidence];
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
  return { compatible: true, evidence, metadata: { ...ultracode.metadata, nativeApiAuth: nativeApiAuth.metadata, fast: { runner, factory, reader, paths, normalizer, deepMerge } } };
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
    [m.nativeApiAuth.byok.body, patchedNativeApiAuth(m.nativeApiAuth), 'Use API-key semantics for existing sealed native Claude BYOK credentials'],
  ];
  for (const [before, after, label] of edits) source = replaceOnce(source, before, after, label);
  return { source, changes: edits.map(edit => edit[2]), evidence: detected.evidence, metadata: m };
}

module.exports = { MARKER, NATIVE_AUTH_MARKER, detectClaudeNativeApiAuth, patchClaudeNativeApiAuth, detectClaudeControlsBackend, patchClaudeControlsBackend };
