'use strict';

// Standard ASAR container operations only. This module does not alter Electron
// fuses, executable resources, signatures, or any file on disk.
const crypto = require('node:crypto');
const { constants: bufferConstants } = require('node:buffer');
const { TextDecoder } = require('node:util');
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 128;
const has = (value, key) => Object.hasOwn(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(message) {
  const error = new Error(`Invalid or unsupported ASAR: ${message}`);
  error.code = 'ASAR_INVALID';
  throw error;
}

function archivePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || /[\\\0]/.test(value)) fail('invalid entry path');
  if (value.split('/').some(part => !part || part === '.' || part === '..')) fail('non-canonical entry path');
  return value;
}

function validateJsonKeys(source) {
  // JSON.parse is authoritative for syntax; this second pass rejects duplicate
  // keys (including escaped aliases) rather than silently choosing one entry.
  let index = 0;
  const whitespace = () => { while (/\s/.test(source[index] || '') && index < source.length) index++; };
  function string() {
    const start = index++;
    while (index < source.length) {
      const character = source[index++];
      if (character === '\\') { index++; continue; }
      if (character === '"') return JSON.parse(source.slice(start, index));
    }
    fail('unterminated JSON string');
  }
  function value(depth) {
    if (depth > MAX_DEPTH) fail('header nesting is too deep');
    whitespace();
    const character = source[index];
    if (character === '"') { string(); return; }
    if (character === '{') {
      index++; whitespace();
      const keys = new Set();
      if (source[index] === '}') { index++; return; }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail('duplicate JSON object key');
        keys.add(key); whitespace(); index++; value(depth + 1); whitespace();
        if (source[index++] === '}') return;
      }
    }
    if (character === '[') {
      index++; whitespace();
      if (source[index] === ']') { index++; return; }
      for (;;) {
        value(depth + 1); whitespace();
        if (source[index++] === ']') return;
      }
    }
    while (index < source.length && !/[\s,}\]]/.test(source[index])) index++;
  }
  value(0); whitespace();
  if (index !== source.length) fail('unexpected JSON trailing data');
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function safeSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is not a non-negative safe integer`);
  return value;
}

function parseAsar(input) {
  if (!Buffer.isBuffer(input)) throw new TypeError('ASAR input must be a Buffer');
  if (input.length < 16) fail('truncated Pickle header');
  const sizePayload = input.readUInt32LE(0);
  const headerSize = input.readUInt32LE(4);
  const payloadSize = input.readUInt32LE(8);
  const jsonSize = input.readUInt32LE(12);
  const alignedPayload = Math.ceil((4 + jsonSize) / 4) * 4;
  if (sizePayload !== 4 || headerSize !== payloadSize + 4 || payloadSize !== alignedPayload ||
      headerSize < 8 || headerSize > MAX_HEADER_BYTES || headerSize % 4 !== 0) fail('inconsistent Pickle lengths');
  const dataOffset = 8 + headerSize;
  if (dataOffset > input.length || jsonSize > payloadSize - 4) fail('header extends beyond the archive');
  for (let i = 16 + jsonSize; i < dataOffset; i++) if (input[i] !== 0) fail('nonzero Pickle padding');
  let text, header;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input.subarray(16, 16 + jsonSize));
    header = JSON.parse(text);
  } catch { fail('header is not valid UTF-8 JSON'); }
  validateJsonKeys(text);
  if (!isObject(header) || !has(header, 'files') || !isObject(header.files)) fail('root files object is missing');
  const dataLength = input.length - dataOffset;
  const internal = new Map(), ranges = [];
  function walk(files, prefix = '', depth = 0) {
    if (depth > MAX_DEPTH) fail('entry tree is too deep');
    for (const [name, metadata] of Object.entries(files)) {
      if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) fail('invalid entry name');
      const entryPath = archivePath(prefix + name);
      if (!isObject(metadata)) fail(`entry metadata is not an object: ${entryPath}`);
      if (has(metadata, 'unpacked') && typeof metadata.unpacked !== 'boolean') fail(`invalid unpacked flag: ${entryPath}`);
      const directory = has(metadata, 'files'), link = has(metadata, 'link');
      let record;
      if (directory) {
        if (!isObject(metadata.files) || link || has(metadata, 'offset') || has(metadata, 'size')) fail(`ambiguous directory: ${entryPath}`);
        record = { path: entryPath, type: 'directory', metadata };
        internal.set(entryPath, record);
        walk(metadata.files, entryPath + '/', depth + 1);
        continue;
      }
      if (link) {
        if (typeof metadata.link !== 'string' || !metadata.link || metadata.link.includes('\0') ||
            has(metadata, 'offset') || has(metadata, 'size') || metadata.unpacked === true) fail(`ambiguous link: ${entryPath}`);
        record = { path: entryPath, type: 'link', metadata };
      } else if (metadata.unpacked === true) {
        if (has(metadata, 'offset')) fail(`unpacked entry has a packed offset: ${entryPath}`);
        record = { path: entryPath, type: 'unpacked', metadata, size: safeSize(metadata.size, 'unpacked size') };
      } else {
        const size = safeSize(metadata.size, 'packed size');
        if (typeof metadata.offset !== 'string' || !/^(0|[1-9]\d*)$/.test(metadata.offset)) fail(`invalid packed offset: ${entryPath}`);
        const offset = safeSize(Number(metadata.offset), 'packed offset');
        if (offset > dataLength || size > dataLength - offset) fail(`packed entry is out of bounds: ${entryPath}`);
        record = { path: entryPath, type: 'file', metadata, size, offset };
        if (size) ranges.push({ start: offset, end: offset + size, path: entryPath });
      }
      if (internal.has(entryPath)) fail(`duplicate entry path: ${entryPath}`);
      internal.set(entryPath, record);
    }
  }
  walk(header.files);
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].start < ranges[i - 1].end) fail('packed entry ranges overlap');
  freeze(header);
  for (const entry of internal.values()) Object.freeze(entry);
  function getEntry(entryPath) {
    archivePath(entryPath);
    const entry = internal.get(entryPath);
    if (!entry) fail(`entry does not exist: ${entryPath}`);
    return entry;
  }
  function readFile(entryPath) {
    const entry = getEntry(entryPath);
    if (entry.type !== 'file') fail(`cannot read a ${entry.type} as a packed file: ${entryPath}`);
    return Buffer.from(input.subarray(dataOffset + entry.offset, dataOffset + entry.offset + entry.size));
  }
  // Public Map mutations do not affect readFile/getEntry's private index.
  return Object.freeze({ header, headerSize, dataOffset, dataLength,
    entries: new Map(internal), entryList: Object.freeze([...internal.values()]), getEntry, readFile });
}

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function integrityFor(metadata, data) {
  if (!has(metadata, 'integrity')) return undefined;
  const original = metadata.integrity;
  if (!isObject(original) || typeof original.algorithm !== 'string' || original.algorithm.toUpperCase() !== 'SHA256') fail('unsupported integrity algorithm');
  if (typeof original.hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(original.hash)) fail('invalid integrity hash');
  const result = { ...original, hash: sha256(data) };
  if (has(original, 'blockSize') || has(original, 'blocks')) {
    if (!Number.isSafeInteger(original.blockSize) || original.blockSize <= 0 || !Array.isArray(original.blocks) ||
        !original.blocks.every(hash => typeof hash === 'string' && /^[a-fA-F0-9]{64}$/.test(hash))) fail('invalid integrity block metadata');
    result.blocks = [];
    for (let offset = 0; offset < data.length; offset += original.blockSize) result.blocks.push(sha256(data.subarray(offset, Math.min(data.length, offset + original.blockSize))));
  }
  return result;
}

function verifyOriginalIntegrity(metadata, data) {
  const computed = integrityFor(metadata, data);
  if (!computed) return;
  const original = metadata.integrity;
  if (computed.hash.toLowerCase() !== original.hash.toLowerCase() ||
      computed.blocks && (computed.blocks.length !== original.blocks.length || computed.blocks.some((hash, i) => hash !== original.blocks[i].toLowerCase()))) {
    fail('original replacement target fails its integrity check');
  }
}

function mutableEntry(header, entryPath) {
  const parts = archivePath(entryPath).split('/');
  let files = header.files, entry;
  for (let i = 0; i < parts.length; i++) {
    if (!has(files, parts[i])) fail('replacement entry disappeared from cloned header');
    entry = files[parts[i]];
    if (i < parts.length - 1) files = entry.files;
  }
  return entry;
}

function serializeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const payloadSize = Math.ceil((4 + json.length) / 4) * 4;
  const headerSize = payloadSize + 4;
  if (headerSize > MAX_HEADER_BYTES || headerSize > 0xffffffff) fail('replacement header is too large');
  const output = Buffer.alloc(8 + headerSize);
  output.writeUInt32LE(4, 0);
  output.writeUInt32LE(headerSize, 4);
  output.writeUInt32LE(payloadSize, 8);
  output.writeUInt32LE(json.length, 12);
  json.copy(output, 16);
  return output;
}

function replaceAsar(input, replacements) {
  const parsed = parseAsar(input);
  if (!(replacements instanceof Map) && (!isObject(replacements) || ![Object.prototype, null].includes(Object.getPrototypeOf(replacements)))) {
    throw new TypeError('ASAR replacements must be a Map or plain object');
  }
  const items = replacements instanceof Map ? [...replacements] : Object.entries(replacements);
  const header = JSON.parse(JSON.stringify(parsed.header));
  const additions = [];
  let nextOffset = parsed.dataLength;
  for (const [entryPath, replacement] of items) {
    if (!Buffer.isBuffer(replacement)) throw new TypeError('Every ASAR replacement value must be a Buffer');
    const record = parsed.getEntry(entryPath);
    if (record.type !== 'file') fail(`cannot replace a ${record.type}: ${entryPath}`);
    const original = parsed.readFile(entryPath);
    verifyOriginalIntegrity(record.metadata, original);
    if (original.equals(replacement)) continue;
    const newEnd = nextOffset + replacement.length;
    if (!Number.isSafeInteger(newEnd) || newEnd > bufferConstants.MAX_LENGTH) fail('replacement data is too large');
    const entry = mutableEntry(header, entryPath);
    const integrity = integrityFor(entry, replacement);
    entry.offset = String(nextOffset);
    entry.size = replacement.length;
    if (integrity !== undefined) entry.integrity = integrity;
    additions.push(replacement);
    nextOffset = newEnd;
  }
  if (!additions.length) return Buffer.from(input);
  const encoded = serializeHeader(header);
  const total = encoded.length + nextOffset;
  if (!Number.isSafeInteger(total) || total > bufferConstants.MAX_LENGTH) fail('replacement archive is too large');
  return Buffer.concat([encoded, input.subarray(parsed.dataOffset), ...additions], total);
}

module.exports = { parseAsar, replaceAsar };
