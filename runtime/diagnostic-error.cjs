'use strict';

// Only retain bounded static adapter metadata, never arbitrary error context.
function diagnosticError(error) {
  const result = { code: error.code || 'ERROR', message: error.message };
  const raw = error.details;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const details = {};
  for (const key of ['family', 'responsibility', 'function']) {
    if (typeof raw[key] === 'string' && raw[key].length <= 160) details[key] = raw[key];
  }
  for (const key of ['fingerprint', 'actualFingerprint']) {
    if (typeof raw[key] === 'string' && /^[a-f0-9]{64}$/.test(raw[key])) details[key] = raw[key];
  }
  if (Array.isArray(raw.expectedFingerprints)) {
    const expected = raw.expectedFingerprints.filter(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)).slice(0, 16);
    if (expected.length) details.expectedFingerprints = expected;
  }
  if (Object.keys(details).length) result.details = details;
  return result;
}

module.exports = { diagnosticError };
