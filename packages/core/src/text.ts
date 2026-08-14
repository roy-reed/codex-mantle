const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const decoder = new TextDecoder("utf-8", { fatal: true });

export type NewlineStyle = "\n" | "\r\n" | "\r";

export interface Utf8TextDocument {
  readonly bom: boolean;
  readonly finalNewline: boolean;
  readonly newline: NewlineStyle;
  readonly text: string;
}

export interface ManagedBlockOptions {
  readonly blockId: string;
  readonly content: string;
}

export class TextEncodingError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TextEncodingError";
  }
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function detectNewline(text: string): NewlineStyle {
  const crlfCount = countMatches(text, /\r\n/gu);
  const withoutCrlf = text.replaceAll("\r\n", "");
  const lfCount = countMatches(withoutCrlf, /\n/gu);
  const crCount = countMatches(withoutCrlf, /\r/gu);

  if (crlfCount >= lfCount && crlfCount >= crCount && crlfCount > 0) {
    return "\r\n";
  }
  if (crCount > lfCount && crCount > 0) {
    return "\r";
  }
  return "\n";
}

function endsWithNewline(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}

export function decodeUtf8Text(input: Uint8Array): Utf8TextDocument {
  const bytes = Buffer.from(input);
  const bom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const body = bom ? bytes.subarray(UTF8_BOM.length) : bytes;

  if (body.includes(0)) {
    throw new TextEncodingError("NUL bytes are not allowed in managed text files");
  }

  let text: string;
  try {
    text = decoder.decode(body);
  } catch (error) {
    throw new TextEncodingError("Managed text files must be valid UTF-8", { cause: error });
  }

  return {
    bom,
    finalNewline: endsWithNewline(text),
    newline: detectNewline(text),
    text,
  };
}

export function encodeUtf8Text(
  document: Pick<Utf8TextDocument, "bom"> & { readonly text: string },
): Buffer {
  const body = Buffer.from(document.text, "utf8");
  return document.bom ? Buffer.concat([UTF8_BOM, body]) : body;
}

function normalizeNewlines(text: string, newline: NewlineStyle): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", newline);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function markerPattern(marker: string): RegExp {
  return new RegExp(`^${escapeRegExp(marker)}[\\t ]*$`, "gmu");
}

function markerMatches(text: string, marker: string): RegExpExecArray[] {
  const pattern = markerPattern(marker);
  const matches: RegExpExecArray[] = [];
  let match = pattern.exec(text);
  while (match !== null) {
    matches.push(match);
    match = pattern.exec(text);
  }
  return matches;
}

/**
 * Replaces only a named managed block. Bytes outside an existing block remain
 * untouched; a new block uses the file's dominant newline and BOM policy.
 */
export function applyManagedBlock(input: Uint8Array, options: ManagedBlockOptions): Buffer {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(options.blockId)) {
    throw new Error("Managed block id must be 1-64 portable identifier characters");
  }
  if (options.content.includes("\0")) {
    throw new Error("Managed block content cannot contain NUL bytes");
  }

  const document = decodeUtf8Text(input);
  const beginMarker = `<!-- codex-mantle:${options.blockId}:begin -->`;
  const endMarker = `<!-- codex-mantle:${options.blockId}:end -->`;
  const beginMatches = markerMatches(document.text, beginMarker);
  const endMatches = markerMatches(document.text, endMarker);

  if (beginMatches.length !== endMatches.length || beginMatches.length > 1) {
    throw new Error(`Managed block ${options.blockId} is malformed or duplicated`);
  }

  const normalizedContent = normalizeNewlines(options.content, document.newline).replace(
    /(?:\r\n|\r|\n)+$/u,
    "",
  );
  if (
    markerMatches(normalizeNewlines(normalizedContent, "\n"), beginMarker).length > 0 ||
    markerMatches(normalizeNewlines(normalizedContent, "\n"), endMarker).length > 0
  ) {
    throw new Error(`Managed block ${options.blockId} content cannot contain its own markers`);
  }
  const block = [beginMarker, normalizedContent, endMarker]
    .filter((part, index) => index !== 1 || part.length > 0)
    .join(document.newline);

  let nextText: string;
  if (beginMatches.length === 0) {
    if (document.text.length === 0) {
      nextText = `${block}${document.newline}`;
    } else {
      const separator = document.finalNewline
        ? document.newline
        : `${document.newline}${document.newline}`;
      nextText = `${document.text}${separator}${block}${document.newline}`;
    }
  } else {
    const begin = beginMatches[0];
    const end = endMatches[0];
    if (begin === undefined || end === undefined || begin.index >= end.index) {
      throw new Error(`Managed block ${options.blockId} markers are out of order`);
    }

    const endIndex = end.index + end[0].length;
    nextText = `${document.text.slice(0, begin.index)}${block}${document.text.slice(endIndex)}`;
  }

  return encodeUtf8Text({ bom: document.bom, text: nextText });
}
