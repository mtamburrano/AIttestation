export const MAX_TEXT_BYTES = 256 * 1024;

// Reject lone surrogates before UTF-8 encoding can replace the observed bytes.
export function validateText(text) {
  if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    throw Error('Unsupported observation: exact UTF-8 text up to 256 KiB required');
  }
  return text;
}
