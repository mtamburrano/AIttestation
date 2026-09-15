import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LocalDiagnostics, validateDiagnosticEvent } from '../diagnostics/local.mjs';

export const DEBUG_SESSION_LIMITS = Object.freeze({ events: 2048, bytes: 512 * 1024,
  ageMs: 24 * 60 * 60_000, segments: 16, segmentEvents: 128, segmentBytes: 64 * 1024 });
export const DEBUG_STORAGE_LIMITS = Object.freeze({ databaseBytes: 2 * 1024 * 1024,
  walBytes: 4 * 1024 * 1024, exportBytes: DEBUG_SESSION_LIMITS.bytes + 1024 });
const PROFILE = 'pap-owner-debug-session/1', APPLICATION_ID = 0x50414444;
const SCHEMA = 'CREATE TABLE journal (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)';
const fail = () => Error('OWNER_DEBUG_SESSION_UNAVAILABLE');
const count = value => Number.isSafeInteger(value) && value >= 0;
const size = value => Buffer.byteLength(JSON.stringify(value));
function keys(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== names.split(',').sort().join(',')) throw fail();
}
function ownerDirectory(path) {
  const info = lstatSync(path);
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path
      || !info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700) throw fail();
  return info;
}
function ownerFile(path, limit, mode = 0o600) {
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid()
      || (info.mode & 0o7777) !== mode || info.size > limit || realpathSync(path) !== path) throw fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw fail();
    return { info, bytes: readFileSync(fd) };
  } finally { closeSync(fd); }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function indexMarker(path) {
  const mode = lstatSync(path).mode & 0o7777;
  if (![0o400, 0o600].includes(mode)) throw fail();
  return ownerFile(path, 0, mode).info;
}
function validateWAL(wal) {
  if (!wal.length) return;
  if (wal.length < 32 || ![0x377f0682, 0x377f0683].includes(wal.readUInt32BE(0))
      || wal.readUInt32BE(4) !== 3007000 || wal.readUInt32BE(8) !== 4096) throw fail();
  const word = offset => wal.readUInt32BE(0) === 0x377f0682 ? wal.readUInt32LE(offset) : wal.readUInt32BE(offset);
  let first = 0, second = 0;
  const checksum = (start, end) => {
    for (let offset = start; offset < end; offset += 8) {
      first = (first + word(offset) + second) >>> 0;
      second = (second + word(offset + 4) + first) >>> 0;
    }
  };
  checksum(0, 24);
  if (first !== wal.readUInt32BE(24) || second !== wal.readUInt32BE(28)) throw fail();
  // Only an incomplete final frame is a possible interrupted append. Complete
  // frames must match SQLite's salts/checksums before SQLite can consume them.
  for (let offset = 32; offset + 24 <= wal.length; offset += 4120) {
    if (!wal.readUInt32BE(offset) || wal.readUInt32BE(offset) > 512 || wal.readUInt32BE(offset + 4) > 512
        || wal.readUInt32BE(offset + 8) !== wal.readUInt32BE(16)
        || wal.readUInt32BE(offset + 12) !== wal.readUInt32BE(20)) throw fail();
    if (offset + 4120 > wal.length) break;
    checksum(offset, offset + 8); checksum(offset + 24, offset + 4120);
    if (first !== wal.readUInt32BE(offset + 16) || second !== wal.readUInt32BE(offset + 20)) throw fail();
  }
}
function validateState(state, limits) {
  keys(state, 'profile,sessionId,enabled,createdAt,updatedAt,droppedEvents,nextSegment,segments');
  if (state.profile !== PROFILE || typeof state.sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(state.sessionId)
      || typeof state.enabled !== 'boolean' || !count(state.createdAt) || !count(state.updatedAt)
      || state.updatedAt < state.createdAt || !count(state.droppedEvents) || !count(state.nextSegment)
      || !Array.isArray(state.segments) || state.segments.length > limits.segments || size(state) > limits.bytes) throw fail();
  let events = 0, previousId = 0, previousTime = state.createdAt;
  const sequences = new Map();
  for (const segment of state.segments) {
    keys(segment, 'id,startedAt,epochId,events');
    if (!count(segment.id) || segment.id <= previousId || segment.id >= state.nextSegment
        || !count(segment.startedAt) || segment.startedAt < previousTime || segment.startedAt > state.updatedAt
        || !Array.isArray(segment.events) || !segment.events.length || segment.events.length > limits.segmentEvents
        || size(segment) > limits.segmentBytes) throw fail();
    for (const event of segment.events) {
      validateDiagnosticEvent(event);
      if (event.code === 'BRIDGE_STATE' || !event.epochId || event.epochId !== segment.epochId
          || event.sequence <= (sequences.get(event.epochId) ?? 0)) throw fail();
      sequences.set(event.epochId, event.sequence);
    }
    events += segment.events.length; previousId = segment.id; previousTime = segment.startedAt;
  }
  if (events > limits.events) throw fail();
  return state;
}

// This module is copied only by the private-development packager. No environment
// switch, evidence-vault path, send state or credentials are accepted here.
export class OwnerDebugSession {
  #control; #directory; #path; #db; #identity; #directoryIdentity; #state; #failed = false; #closed = false;
  #limits; #now; #timer; #afterCommit;
  constructor(controlDirectory, { limits = {}, now = Date.now, afterCommit = () => {} } = {}) {
    keys(limits, Object.keys(limits).join(','));
    for (const [key, value] of Object.entries(limits)) if (!Object.hasOwn(DEBUG_SESSION_LIMITS, key)
        || !Number.isSafeInteger(value) || value < (key.endsWith('Bytes') || key === 'bytes' ? 1024 : 1)
        || value > DEBUG_SESSION_LIMITS[key]) throw fail();
    this.#limits = { ...DEBUG_SESSION_LIMITS, ...limits }; this.#now = now; this.#afterCommit = afterCommit;
    this.#control = controlDirectory; this.#directory = join(controlDirectory, 'debug-session');
    this.#path = join(this.#directory, 'journal.sqlite');
    try {
      ownerDirectory(this.#control);
      if (existsSync(this.#directory) || readdirSync(this.#control).includes('debug-session')) this.#open();
      this.#prune();
    } catch { this.#disable(); }
    this.diagnostics = new LocalDiagnostics({ onEvent: event => this.#record(event) });
    this.#timer = setInterval(() => this.status(), Math.min(60_000, this.#limits.ageMs));
    this.#timer.unref();
  }
  #files() {
    ownerDirectory(this.#control);
    const directory = ownerDirectory(this.#directory);
    if (this.#directoryIdentity && (directory.ino !== this.#directoryIdentity.ino
        || directory.dev !== this.#directoryIdentity.dev)) throw fail();
    this.#directoryIdentity ??= directory;
    if (readdirSync(this.#directory).some(name => !['journal.sqlite', 'journal.sqlite-wal', 'journal.sqlite-shm'].includes(name))) throw fail();
    indexMarker(`${this.#path}-shm`);
    const { info, bytes } = ownerFile(this.#path, DEBUG_STORAGE_LIMITS.databaseBytes);
    if (this.#identity && (info.ino !== this.#identity.ino || info.dev !== this.#identity.dev)) throw fail();
    if (bytes.length < 100 || bytes.subarray(0, 16).toString() !== 'SQLite format 3\0'
        || bytes.readUInt16BE(16) !== 4096 || bytes[18] !== 2 || bytes[19] !== 2 || bytes.readUInt32BE(68) !== APPLICATION_ID
        || bytes.readUInt32BE(60) !== 1) throw fail();
    this.#identity ??= info;
    if (existsSync(`${this.#path}-wal`) || readdirSync(this.#directory).includes('journal.sqlite-wal')) {
      validateWAL(ownerFile(`${this.#path}-wal`, DEBUG_STORAGE_LIMITS.walBytes).bytes);
    }
  }
  #read(db, { exclusive = true, immutable = false } = {}) {
    db.exec(`PRAGMA locking_mode=${exclusive ? 'EXCLUSIVE' : 'NORMAL'}; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0`);
    if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID
        || db.prepare('PRAGMA user_version').get().user_version !== 1
        || !immutable && db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal'
        || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw fail();
    const schema = db.prepare('SELECT sql FROM sqlite_schema').all();
    if (schema.length !== 1 || schema[0].sql !== SCHEMA) throw fail();
    const rows = db.prepare('SELECT id, payload FROM journal').all();
    if (rows.length !== 1 || rows[0].id !== 1 || Buffer.byteLength(rows[0].payload) > this.#limits.bytes) throw fail();
    const state = JSON.parse(rows[0].payload);
    if (JSON.stringify(state) !== rows[0].payload) throw fail();
    return validateState(state, this.#limits);
  }
  #configure() {
    this.#db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0;'
      + ' PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA wal_autocheckpoint=0; PRAGMA max_page_count=512');
  }
  #open() {
    this.#files();
    // A read-only probe cannot checkpoint a malformed session on close. The
    // empty owner-only index is made read-only for SQLite's initial open, forcing
    // an in-memory index. SQLite itself may reset its mode to 0600; both modes
    // are valid interrupted-probe states, but nonempty or unsafe files never are.
    const immutable = !existsSync(`${this.#path}-wal`) || lstatSync(`${this.#path}-wal`).size === 0;
    const indexPath = `${this.#path}-shm`, before = indexMarker(indexPath);
    const index = openSync(indexPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let reader;
    try {
      if (fstatSync(index).ino !== before.ino || fstatSync(index).dev !== before.dev) throw fail();
      fchmodSync(index, 0o400);
      reader = new DatabaseSync(immutable ? `${pathToFileURL(this.#path).href}?immutable=1` : this.#path, { readOnly: true });
      this.#state = this.#read(reader, { exclusive: false, immutable });
    } finally {
      try {
        reader?.close();
        const after = indexMarker(indexPath);
        if (after.ino !== before.ino || after.dev !== before.dev) throw fail();
        fchmodSync(index, before.mode & 0o7777);
      } finally { closeSync(index); }
    }
    this.#files();
    this.#db = new DatabaseSync(this.#path);
    this.#state = this.#read(this.#db); this.#configure();
    this.#db.exec('BEGIN EXCLUSIVE');
    this.#state = this.#read(this.#db); this.#db.exec('COMMIT');
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.#files();
  }
  #create() {
    ownerDirectory(this.#control);
    mkdirSync(this.#directory, { mode: 0o700 });
    ownerDirectory(this.#directory);
    const fd = openSync(this.#path, 'wx', 0o600); closeSync(fd);
    const index = openSync(`${this.#path}-shm`, 'wx', 0o600); closeSync(index);
    this.#db = new DatabaseSync(this.#path); this.#configure();
    this.#db.exec(`PRAGMA page_size=4096; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`
      + ` PRAGMA journal_mode=WAL; ${SCHEMA}`);
    const now = this.#time();
    this.#state = { profile: PROFILE, sessionId: randomBytes(16).toString('hex'), enabled: true,
      createdAt: now, updatedAt: now, droppedEvents: 0, nextSegment: 1, segments: [] };
    this.#db.prepare('INSERT INTO journal VALUES (1, ?)').run(JSON.stringify(this.#state));
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    syncDirectory(this.#directory); syncDirectory(this.#control); this.#files();
  }
  #time() {
    const now = this.#now();
    if (!count(now) || this.#state && now < this.#state.updatedAt) throw fail();
    return now;
  }
  #disable() {
    this.#failed = true;
    try { this.#db?.close(); } catch {}
    this.#db = null;
  }
  #drop() {
    this.#state.droppedEvents = Math.min(Number.MAX_SAFE_INTEGER,
      this.#state.droppedEvents + this.#state.segments.shift().events.length);
  }
  #trim(now) {
    const { segments } = this.#state;
    while (segments.length && (now - segments[0].startedAt >= this.#limits.ageMs
        || segments.length > this.#limits.segments
        || segments.reduce((sum, segment) => sum + segment.events.length, 0) > this.#limits.events
        || size(this.#state) > this.#limits.bytes)) this.#drop();
  }
  #save() {
    this.#files();
    const content = JSON.stringify(validateState(this.#state, this.#limits));
    this.#db.prepare('UPDATE journal SET payload=? WHERE id=1').run(content);
    // FULL WAL commit precedes return. Checkpointing bounds old on-disk pages;
    // a crash between these steps still retains the committed event.
    this.#afterCommit();
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.#files();
  }
  #prune() {
    if (!this.#state || this.#failed || this.#closed) return;
    this.#files();
    const now = this.#time(), previous = this.#state.droppedEvents;
    this.#trim(now);
    if (this.#state.droppedEvents !== previous) { this.#state.updatedAt = now; this.#save(); }
  }
  #record(event) {
    if (!this.#state?.enabled || this.#failed || this.#closed) return;
    try {
      validateDiagnosticEvent(event);
      if (!event.epochId || event.code === 'BRIDGE_STATE') throw fail();
      const now = this.#time(), saved = structuredClone(event), { segments } = this.#state;
      this.#trim(now);
      let segment = segments.at(-1);
      if (!segment || segment.epochId !== event.epochId || segment.events.length >= this.#limits.segmentEvents
          || size({ ...segment, events: [...segment.events, saved] }) > this.#limits.segmentBytes) {
        segment = { id: this.#state.nextSegment++, startedAt: now, epochId: event.epochId, events: [] };
        segments.push(segment);
      }
      segment.events.push(saved); this.#state.updatedAt = now;
      this.#trim(now); this.#save();
    } catch { this.#disable(); }
  }
  status() {
    try { this.#prune(); } catch { this.#disable(); }
    if (this.#failed || this.#closed) return { state: 'UNAVAILABLE', retainedEvents: 0, segments: 0, exportAvailable: false };
    return { state: this.#state?.enabled ? 'RECORDING' : 'STOPPED', sessionId: this.#state?.sessionId ?? null,
      retainedEvents: this.#state?.segments.reduce((sum, segment) => sum + segment.events.length, 0) ?? 0,
      segments: this.#state?.segments.length ?? 0, droppedEvents: this.#state?.droppedEvents ?? 0,
      exportAvailable: Boolean(this.#state), limits: { ...this.#limits } };
  }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean' || this.#failed || this.#closed) throw fail();
    try {
      if (!this.#state) { if (enabled) this.#create(); }
      else {
        this.#prune(); this.#state.enabled = enabled; this.#state.updatedAt = this.#time(); this.#save();
      }
      return this.status();
    } catch { this.#disable(); throw fail(); }
  }
  export() {
    if (this.status().state === 'UNAVAILABLE' || !this.#state) throw fail();
    // A serialized snapshot cannot change while later events or rotations append.
    const content = JSON.stringify({ ...this.#state, limits: this.#limits });
    if (Buffer.byteLength(content) > DEBUG_STORAGE_LIMITS.exportBytes) throw fail();
    return content;
  }
  close() {
    clearInterval(this.#timer);
    this.#closed = true; this.#db?.close(); this.#db = null;
  }
}
