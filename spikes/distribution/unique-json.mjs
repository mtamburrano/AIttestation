export class JSONStructureError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function parseUniqueJSON(text) {
  // Check decoded names in each original object before JSON.parse can discard
  // shadowed values. Sibling objects have independent member namespaces.
  const stack = []; let count = 0;
  for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"\s*:?|[{}\[\]]/g)) {
    if (++count > 1_000_000) throw new JSONStructureError('CONTENT_LIMIT');
    const value = token[0];
    if (value === '{' || value === '[') {
      if (stack.length >= 32) throw new JSONStructureError('CONTENT_LIMIT');
      stack.push(value === '{' ? new Set() : null);
    } else if (value === '}' || value === ']') stack.pop();
    else if (value.endsWith(':')) {
      const key = JSON.parse(value.slice(0, -1).trim()), names = stack.at(-1);
      if (!(names instanceof Set)) throw new SyntaxError('INVALID_JSON_MEMBER');
      if (names.has(key)) throw new JSONStructureError('AMBIGUOUS_JSON');
      names.add(key);
    }
  }
  return JSON.parse(text);
}
