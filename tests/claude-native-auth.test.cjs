'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fixture = require('./fixtures/claude-native-auth.cjs');
const { extractFunction } = require('../runtime/compat.cjs');
const { NATIVE_AUTH_MARKER, detectClaudeNativeApiAuth, patchClaudeNativeApiAuth } = require('../runtime/claude-controls-backend.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const original = detectClaudeNativeApiAuth(fixture).metadata;
const patched = patchClaudeNativeApiAuth(fixture);
// 830's reviewed adapter adds this same native default in both the bridge and
// external-native branches. Keep the original fixture for legacy regression.
const fixture830 = fixture.replace('...yes,...Aes', '...yes,...Aes,...nativeTrafficDefaults')
  .replace(',yes,Aes)', ',yes,Aes,nativeTrafficDefaults)')
  + '\nnativeTrafficDefaults={"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1"};';
const patched830 = patchClaudeNativeApiAuth(fixture830);
// 842 adds a resolved-context override in the bridge and external-native branch.
// The helpers below are credential-free copies of the reviewed function shapes.
const fixture842 = fixture830.replace('...ves(c10),...kes(c10)', '...ves(c10),...expandContext(c10),...kes(c10)')
  .replace('Object["assign"](h9,Ses(c10["modelId"]),', 'Object["assign"](h9,expandContext(c10),Ses(c10["modelId"]),')
  + '\nfunction expandContext(profile){let context=resolveNativeContext(profile);return context&&context>nativeContextThreshold?{"CLAUDE_CODE_DISABLE_1M_CONTEXT":""}:{}}'
  + '\nfunction ves(profile){let context=resolveNativeContext(profile);return context&&context>0?{"CLAUDE_CODE_MAX_CONTEXT_TOKENS":String(context)}:{}}'
  + '\nfunction resolveNativeContext(profile){let context=profile["contextWindow"];return typeof context=="number"&&context>0?context:lookupContext(profile["providerId"],profile["modelId"])?.["contextLength"]??null}'
  + '\nnativeContextThreshold=2e5;';
const patched842 = patchClaudeNativeApiAuth(fixture842);

function runtime(source, input = {}) {
  const context = {
    dw: (agent, provider) => agent === 'claude' && provider.supported !== false,
    uw: { env: {}, argvAppend: [], modelOverride: null },
    tft: provider => provider.native !== false,
    nft: () => 'responses', gft: async () => 12345, hft: async () => 12345,
    bfe: (_agent, session) => session, A6: () => '/fixture', nf: provider => provider.baseURL,
    ves: () => ({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' }),
    kes: () => ({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000' }),
    Ses: model => ({ CLAUDE_CODE_SUBAGENT_MODEL: model }),
    bes: env => ['--settings', JSON.stringify({ env })],
    o1: provider => provider.baseURL,
    Z7r: (_provider, profile) => profile.envOverrides || {},
    FRa: base => new URL(base).hostname === 'api.anthropic.com',
    yes: { CLAUDE_CODE_AUTO_MODE_SERVER: '0' }, Aes: { CLAUDE_CODE_INLINE_TOOLS: '0' },
    lookupContext: () => input.registryContext == null ? undefined : { contextLength: input.registryContext },
  };
  vm.createContext(context);
  new vm.Script(source).runInContext(context);
  return context;
}

function inputs(overrides = {}) {
  return {
    provider: { kind: 'anthropic', name: 'fixture', baseURL: 'https://provider.invalid', wire: { anthropicAuth: 'unknown' }, ...overrides.provider },
    profile: { modelId: 'claude-opus-5-5', ...overrides.profile },
    credential: { plain: false, value: 'existing-sealed-test-credential',
      direct: async () => 'http://127.0.0.1:12345/fixture/k/existing-route',
      bridgeToken: () => 'existing-bridge-route', ...overrides.credential },
    options: { sessionId: 'fixture-session' },
    registryContext: overrides.registryContext,
  };
}

async function run(source, input) {
  const context = runtime(source, input);
  return plain(await context[original.byok.name](input.provider, input.profile, input.credential, input.options));
}

test('842, 830/840, 828/827/824 and the reviewed legacy BYOK shapes are accepted', () => {
  assert.equal(patched.evidence.length, 10);
  assert.equal(patched.evidence.find(item => item.family === 'native-auth-byok').fingerprint,
    '5ce097d912732d97dba70796d09bca525420b4e8d3f35e9be775c5df686e70d3');
  const legacy = fixture.replace('...yes,...Aes', '...yes').replace(',yes,Aes)', ',yes)');
  assert.notEqual(legacy, fixture);
  assert.equal(detectClaudeNativeApiAuth(legacy).evidence.find(item => item.family === 'native-auth-byok').fingerprint,
    '6709d34d2239b74ad4f3796d224d8325d4e89225508d61de3976b19a4ce53f90');
  new vm.Script(patchClaudeNativeApiAuth(legacy).source);
  assert.equal(patched830.evidence.length, 11);
  assert.equal(patched830.evidence.find(item => item.family === 'native-auth-byok').fingerprint,
    'f917061470703c1c16d0a945ed82dc41211c44b5cadeefee42f44325851d97e9');
  assert.equal(patched830.metadata.trafficDefaults.name, 'nativeTrafficDefaults');
  assert.equal(patched842.evidence.length, 15);
  assert.equal(patched842.evidence.find(item => item.family === 'native-auth-byok').fingerprint,
    'de08a550b7ec947700f6fe578e7c10ea7fdda8302a8a17ad36941d5c90b64ea2');
});

test('842 preserves the resolved-context boundary and registry fallback on native and bridge routes', async () => {
  const cases = [
    { explicit: 200000, registry: 1000000, resolved: 200000, clear: false },
    { explicit: 200001, resolved: 200001, clear: true },
    { explicit: 1000000, resolved: 1000000, clear: true },
    { explicit: 199999, resolved: 199999, clear: false },
    { explicit: 0, registry: 1000000, resolved: 1000000, clear: true },
    { explicit: -1, registry: 200000, resolved: 200000, clear: false },
    { explicit: '1000000', registry: 200000, resolved: 200000, clear: false },
    { explicit: '1000000', resolved: null, clear: false },
    { registry: 1000000, resolved: 1000000, clear: true },
    { resolved: null, clear: false },
  ];
  for (const sample of cases) for (const native of [true, false]) {
    const input = inputs({ provider: { native }, profile: { contextWindow: sample.explicit }, registryContext: sample.registry });
    const before = await run(fixture842, input), after = await run(patched842.source, input);
    for (const result of [before, after]) {
      assert.equal(Object.hasOwn(result.env, 'CLAUDE_CODE_DISABLE_1M_CONTEXT'), sample.clear);
      assert.equal(result.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, sample.clear ? '' : undefined);
      assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, sample.resolved === null ? undefined : String(sample.resolved));
      assert.equal(result.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
      assert.deepEqual(JSON.parse(result.argvAppend[1]).env, result.env);
    }
    if (native) {
      assert.equal(after.env.ANTHROPIC_API_KEY, input.credential.value);
      assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, '');
    } else assert.deepEqual(after, before);
  }
});

test('842 keeps the official endpoint exclusion and explicit Bearer behavior with large contexts', async () => {
  const official = inputs({ provider: { baseURL: 'https://api.anthropic.com' }, profile: { contextWindow: 1000000 } });
  for (const source of [fixture842, patched842.source]) {
    const result = await run(source, official);
    assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
    assert.equal(Object.hasOwn(result.env, 'CLAUDE_CODE_DISABLE_1M_CONTEXT'), false);
    assert.equal(Object.hasOwn(result.env, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'), false);
  }
  const bearer = inputs({ provider: { wire: { anthropicAuth: 'bearer' } }, registryContext: 1000000 });
  const result = await run(patched842.source, bearer);
  assert.equal(result.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, '');
  assert.deepEqual(result, await run(fixture842, bearer));
  for (const item of Object.values(patched842.metadata.largeContext)) {
    assert.ok(patched842.source.includes(item.body));
  }
});

test('830 retains its native traffic default while repairing sealed API-key authentication', async () => {
  const input = inputs();
  const before = await run(fixture830, input), after = await run(patched830.source, input);
  assert.equal(before.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(after.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(after.env.ANTHROPIC_API_KEY, input.credential.value);
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, '');
  assert.deepEqual(JSON.parse(after.argvAppend[1]).env, after.env);
  const bridge = inputs({ provider: { native: false } });
  assert.equal((await run(patched830.source, bridge)).env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.deepEqual(await run(patched830.source, bridge), await run(fixture830, bridge));
  const official = inputs({ provider: { baseURL: 'https://api.anthropic.com' } });
  assert.equal((await run(fixture830, official)).env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
  assert.equal((await run(patched830.source, official)).env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
});

test('native sealed Anthropic BYOK reuses the existing credential as API key in env and settings', async () => {
  const input = inputs();
  Object.freeze(input.credential);
  const before = await run(fixture, input), after = await run(patched.source, input);
  assert.equal(before.env.ANTHROPIC_AUTH_TOKEN, input.credential.value);
  assert.equal(before.env.ANTHROPIC_API_KEY, '');
  assert.equal(after.env.ANTHROPIC_API_KEY, input.credential.value);
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, '');
  assert.deepEqual(JSON.parse(after.argvAppend[1]).env, after.env);
  assert.equal(after.env.ANTHROPIC_BASE_URL, before.env.ANTHROPIC_BASE_URL);
  assert.deepEqual(after, { ...before, env: { ...before.env, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: input.credential.value },
    argvAppend: ['--settings', JSON.stringify({ env: { ...before.env, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: input.credential.value } })] });
  assert.equal(input.credential.value, 'existing-sealed-test-credential');
});

const unchanged = [
  ['explicit API-key authentication already works', { provider: { wire: { anthropicAuth: 'x-api-key' } } }],
  ['explicit bearer-only provider', { provider: { wire: { anthropicAuth: 'bearer' } } }],
  ['explicit override to bearer wins over a probe', { provider: { wireOverride: { anthropicAuth: 'bearer' } } }],
  ['unrecognized authentication scheme', { provider: { wire: { anthropicAuth: 'future-auth' } } }],
  ['plain credential', { credential: { plain: true } }],
  ['missing sealed marker', { credential: { plain: undefined } }],
  ['missing credential', { credential: { value: undefined } }],
  ['null credential', { credential: { value: null } }],
  ['empty credential', { credential: { value: '' } }],
  ['blank credential', { credential: { value: ' \t\n' } }],
  ['non-string credential', { credential: { value: 0 } }],
  ['protocol bridge', { provider: { native: false } }],
  ['OpenAI provider', { provider: { kind: 'openai' } }],
  ['unclassified provider', { provider: { kind: 'custom' } }],
  ['unsupported provider', { provider: { supported: false } }],
  ['separate auth override', { profile: { envOverrides: { ANTHROPIC_AUTH_TOKEN: 'separate-test-credential' } } }],
  ['separate API key override', { profile: { envOverrides: { ANTHROPIC_API_KEY: 'separate-test-key' } } }],
];
for (const [label, changes] of unchanged) {
  test(`${label} retains its exact original behavior`, async () => {
    const input = inputs(changes);
    assert.deepEqual(await run(patched.source, input), await run(fixture, input));
    assert.deepEqual(await run(patched830.source, input), await run(fixture830, input));
    assert.deepEqual(await run(patched842.source, input), await run(fixture842, input));
  });
}

test('an explicit API-key override is respected and an official API BYOK still uses its key', async () => {
  const explicit = inputs({ provider: { wire: { anthropicAuth: 'bearer' }, wireOverride: { anthropicAuth: 'x-api-key' } } });
  assert.deepEqual(await run(patched.source, explicit), await run(fixture, explicit));
  const official = inputs({ provider: { baseURL: 'https://api.anthropic.com' } });
  assert.equal((await run(patched.source, official)).env.ANTHROPIC_API_KEY, official.credential.value);
});

test('shared OAuth/auth helpers and the sealed proxy remain byte-identical', () => {
  for (const family of ['credentials', 'auth', 'sealed', 'direct', 'register', 'server', 'proxy', 'headers']) {
    assert.equal(extractFunction(patched.source, original[family].name), original[family].body);
  }
  assert.equal(fixture.replace(original.byok.body, ''), patched.source.replace(
    patched.source.slice(patched.source.indexOf(original.byok.name + '=async'), patched.source.indexOf('\n' + original.credentials.body) - 1), ''));
});

test('unchanged sealed proxy translates the existing API-key credential and preserves Fast beta', () => {
  const context = runtime(patched.source);
  const headers = context[original.headers.name]({ 'x-api-key': 'existing-sealed-test-credential',
    'anthropic-beta': 'fast-mode-2026-02-01', 'content-type': 'application/json', host: '127.0.0.1' }, 'upstream-test-key');
  assert.deepEqual(plain(headers), { 'x-api-key': 'upstream-test-key',
    'anthropic-beta': 'fast-mode-2026-02-01', 'content-type': 'application/json' });
});

test('detector discovers renamed minifier bindings', () => {
  const renamed = fixture.replace(/\b(Ies|wes|_P|iPa|WXr|HXr|W_a|V_a|K_a|Sgn)\b/g, name => `fixture_${name}`);
  assert.notEqual(renamed, fixture);
  assert.equal(detectClaudeNativeApiAuth(renamed).metadata.byok.name, 'fixture_Ies');
  new vm.Script(patchClaudeNativeApiAuth(renamed).source);
});

test('changed or ambiguous auth/transport structures fail closed', () => {
  const variants = [
    fixture + '\n' + original.byok.body,
    fixture.replace(original.credentials.body, original.credentials.body.replace('"x-api-key"', '"other-auth"')),
    fixture.replace(original.drop.body, original.drop.body.replace('["host"', '["x-api-key","host"')),
    fixture.replace(original.proxy.body, original.proxy.body.replace('"redirect":"manual"', '"redirect":"follow"')),
    fixture.replace(original.sealed.body, original.sealed.body.replace('"plain":false', '"plain":true')),
    fixture.replace(original.byok.body, original.byok.body.replace('"CLAUDE_CODE_ATTRIBUTION_HEADER":"0"', '"CLAUDE_CODE_ATTRIBUTION_HEADER":"1"')),
  ];
  for (const changed of variants) {
    assert.notEqual(changed, fixture);
    assert.throws(() => patchClaudeNativeApiAuth(changed), error =>
      ['claude-controls-structure-mismatch', 'claude-controls-unverified-structure', 'structure-mismatch'].includes(error.code));
  }
  assert.throws(() => patchClaudeNativeApiAuth(patched.source), /already patched/);
  assert.equal(patched.source.split(NATIVE_AUTH_MARKER).length, 2);
});

test('830 changed, rebound or ambiguous native traffic defaults fail closed', () => {
  const definition = 'nativeTrafficDefaults={"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1"}';
  const variants = [
    fixture830.replace(definition, 'nativeTrafficDefaults={"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"0"}'),
    fixture830.replace(definition, 'nativeTrafficDefaults={"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1","ANTHROPIC_API_KEY":"changed"}'),
    fixture830 + '\n' + definition + ';',
    fixture830.replace(',yes,Aes,nativeTrafficDefaults)', ',yes,Aes,otherTrafficDefaults)')
      + '\notherTrafficDefaults={"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1"};',
    fixture830.replace('...yes,...Aes,...nativeTrafficDefaults', '...yes,...Aes'),
  ];
  for (const changed of variants) {
    assert.notEqual(changed, fixture830);
    assert.throws(() => patchClaudeNativeApiAuth(changed), error =>
      ['claude-controls-structure-mismatch', 'claude-controls-unverified-structure'].includes(error.code));
  }
});

test('842 changed context boundary, flag, resolver or bindings fail closed', () => {
  const variants = [
    fixture842.replace('nativeContextThreshold=2e5', 'nativeContextThreshold=199999'),
    fixture842.replace('context>nativeContextThreshold', 'context>=nativeContextThreshold'),
    fixture842.replace('"CLAUDE_CODE_DISABLE_1M_CONTEXT":""', '"CLAUDE_CODE_DISABLE_1M_CONTEXT":"1"'),
    fixture842.replace('typeof context=="number"&&context>0?', 'typeof context=="number"&&context>=0?'),
    fixture842.replace('function expandContext(profile){let context=resolveNativeContext(profile);', 'function expandContext(profile){let context=otherResolver(profile);'),
    fixture842 + '\nnativeContextThreshold=2e5;',
    fixture842.replace('...ves(c10),...expandContext(c10),...kes(c10)', '...ves(c10),...kes(c10)'),
    fixture842.replace(',expandContext(c10),Ses(c10["modelId"])', ',otherOverride(c10),Ses(c10["modelId"])'),
  ];
  for (const changed of variants) {
    assert.notEqual(changed, fixture842);
    assert.throws(() => patchClaudeNativeApiAuth(changed), error =>
      ['claude-controls-structure-mismatch', 'claude-controls-unverified-structure', 'structure-mismatch'].includes(error.code));
  }
});
