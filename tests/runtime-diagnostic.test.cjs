'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnosticError } = require('../runtime/diagnostic-error.cjs');

test('diagnostic errors retain the static failing function and reviewed hashes', () => {
  const details = { family: 'fingerprint', responsibility: 'Claude runner reuse identity', function: 'DXr',
    fingerprint: 'a'.repeat(64), actualFingerprint: 'a'.repeat(64), expectedFingerprints: ['b'.repeat(64)] };
  assert.deepEqual(diagnosticError({ code: 'unverified', message: 'changed', details }), { code: 'unverified', message: 'changed', details });
});

test('diagnostic errors do not serialize arbitrary source, request or configuration context', () => {
  const result = diagnosticError({ message: 'changed', details: { family: 'fingerprint', source: 'private source',
    request: { authorization: 'private token' }, config: { key: 'private key' } } });
  assert.deepEqual(result, { code: 'ERROR', message: 'changed', details: { family: 'fingerprint' } });
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('diagnostic metadata rejects malformed hashes and bounds strings and arrays', () => {
  const result = diagnosticError({ message: 'changed', details: {
    family: 'x'.repeat(161), responsibility: {}, function: null, fingerprint: 'bad', actualFingerprint: 'not a hash',
    expectedFingerprints: ['invalid', null, ...Array(40).fill('c'.repeat(64))],
  } });
  assert.deepEqual(Object.keys(result.details), ['expectedFingerprints']);
  assert.equal(result.details.expectedFingerprints.length, 16);
});

test('ordinary filesystem errors retain the existing code and message without invented details', () => {
  for (const details of [undefined, null, [], 'text', {}]) {
    assert.deepEqual(diagnosticError({ code: 'EACCES', message: 'file is locked', details }), { code: 'EACCES', message: 'file is locked' });
  }
});
