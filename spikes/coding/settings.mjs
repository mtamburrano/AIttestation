import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import toml from './vendor/smol-toml/index.cjs';
import { parseUniqueJSON } from '../distribution/unique-json.mjs';

const conflict = () => { throw Error('INTEGRATION_CONFIGURATION_CONFLICT'); };
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const object = value => value && !Array.isArray(value) && typeof value === 'object';
const comparable = value => Array.isArray(value) ? value.map(comparable)
  : value && Object.getPrototypeOf(value) === null ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, comparable(item)])) : value;
export const revision = bytes => createHash('sha256').update(bytes ?? Buffer.alloc(0)).digest('hex');
export const fingerprint = entry => revision(Buffer.from(JSON.stringify(entry)));
const quoteShell = value => `'${value.replaceAll("'", "'\\''")}'`;

export function ownedHook(client, receiver, installationId) {
  const args = [client, installationId];
  return { hooks: [{ type: 'command', ...(client === 'claude-code' ? { command: receiver, args }
    : { command: [receiver, ...args].map(quoteShell).join(' ') }), timeout: 1 }] };
}

export function parseSettings(text, format) {
  if (Buffer.byteLength(text) > 1024 * 1024 || !text.isWellFormed()) conflict();
  try {
    const value = format === 'toml' ? comparable(toml.parse(text, { integersAsBigInt: 'asNeeded', unsafeKeyBehaviour: 'throw' })) : parseUniqueJSON(text);
    if (!object(value) || own(value, 'hooks') !== undefined && !object(value.hooks)
        || own(value.hooks ?? {}, 'UserPromptSubmit') !== undefined && !Array.isArray(value.hooks.UserPromptSubmit)) conflict();
    if ((value.hooks?.UserPromptSubmit?.length ?? 0) > 128) conflict();
    return value;
  } catch { conflict(); }
}

// Tokens carry original byte-string offsets. Strings and comments are opaque,
// so an apparent table/marker in a multiline prompt cannot become an edit site.
function tokens(text, format) {
  const result = []; let i = 0;
  while (i < text.length) {
    const start = i, c = text[i++];
    if (/\s/.test(c)) continue;
    if (format === 'toml' && c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '"' || format === 'toml' && c === "'") {
      const triple = format === 'toml' && text.slice(start, start + 3) === c.repeat(3);
      if (triple) i += 2;
      while (i < text.length) {
        if (c === '"' && text[i] === '\\') { i += 2; continue; }
        if (text[i] === c && (!triple || text.slice(i, i + 3) === c.repeat(3))) { i += triple ? 3 : 1; break; }
        i++;
      }
      result.push({ start, end: i, value: text.slice(start, i), string: true });
    } else result.push({ start, end: i, value: c });
  }
  return result;
}

function jsonNode(text) {
  const list = tokens(text, 'json'); let cursor = 0;
  const next = () => {
    const token = list[cursor++], node = { ...token, children: [], properties: new Map() };
    if (token.value === '{' || token.value === '[') {
      const end = token.value === '{' ? '}' : ']';
      while (list[cursor].value !== end) {
        if (token.value === '{') {
          const key = JSON.parse(list[cursor++].value); cursor++;
          const child = next(); node.properties.set(key, child);
        } else node.children.push(next());
        if (list[cursor].value === ',') cursor++;
      }
      node.end = list[cursor++].end;
    } else if (!token.string) {
      while (cursor < list.length && ![',', '}', ']'].includes(list[cursor].value)) node.end = list[cursor++].end;
    }
    return node;
  };
  return next();
}

function jsonArrayEdit(text, groups) {
  const root = jsonNode(text), hooks = root.properties.get('hooks'), array = hooks?.properties.get('UserPromptSubmit');
  if (array) return text.slice(0, array.start) + JSON.stringify(groups, null, 2) + text.slice(array.end);
  const target = hooks ?? root, key = hooks ? 'UserPromptSubmit' : 'hooks';
  const value = hooks ? groups : { UserPromptSubmit: groups };
  const addition = `${target.properties.size ? ',' : ''}\n  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2)}\n`;
  return text.slice(0, target.end - 1) + addition + text.slice(target.end - 1);
}

function expectedDocument(value, groups) {
  return { ...value, hooks: { ...value.hooks, UserPromptSubmit: groups } };
}
const matches = (text, expected, format) => { try { return isDeepStrictEqual(parseSettings(text, format), expected); } catch { return false; } };

export function editSettings({ text, format, client, installationId, previous = null, next = null, fragment = null }) {
  const value = parseSettings(text, format), groups = value.hooks?.UserPromptSubmit ?? [];
  const ours = groups.map((entry, index) => ({ entry, index })).filter(({ entry }) => JSON.stringify(entry).includes(installationId));
  if (ours.length > 1 || previous && (ours.length !== 1 || !isDeepStrictEqual(ours[0].entry, previous))
      || !previous && ours.length) conflict();
  let updated = [...groups];
  if (previous) updated.splice(ours[0].index, 1);
  if (next) updated.push(next);
  if (format === 'json') return { text: jsonArrayEdit(text, updated), fragment: null };

  let base = text;
  if (previous) {
    if (!fragment || !base.includes(fragment) || base.indexOf(fragment) !== base.lastIndexOf(fragment)) conflict();
    base = base.replace(fragment, '');
    const expected = expectedDocument(value, updated.filter(entry => entry !== next));
    // Removing the only owned array-of-tables also removes that absent property.
    const parsed = parseSettings(base, 'toml');
    if (!parsed.hooks?.UserPromptSubmit && !expected.hooks.UserPromptSubmit.length) delete expected.hooks.UserPromptSubmit;
    if (!parsed.hooks && !Object.keys(expected.hooks).length) delete expected.hooks;
    if (!isDeepStrictEqual(parsed, expected)) conflict();
  }
  if (!next) return { text: base, fragment: null };
  const wanted = expectedDocument(parseSettings(base, 'toml'), updated);
  const handler = next.hooks[0];
  const block = `\n# Attestamp ${installationId}\n[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(handler.command)}\ntimeout = 1\n`;
  if (matches(base + block, wanted, 'toml')) return { text: base + block, fragment: block };
  // Preserve a static inline array as an array. Only the one candidate whose
  // parsed result differs by exactly our handler is eligible for replacement.
  const inline = `{ hooks = [{ type = "command", command = ${JSON.stringify(handler.command)}, timeout = 1 }] }`;
  const candidates = tokens(base, 'toml').filter(token => token.value === ']');
  if (candidates.length > 512) conflict();
  for (const token of candidates) for (const prefix of [', ', '']) {
    const insertion = prefix + inline, changed = base.slice(0, token.start) + insertion + base.slice(token.start);
    if (matches(changed, wanted, 'toml')) return { text: changed, fragment: insertion };
  }
  conflict();
}
