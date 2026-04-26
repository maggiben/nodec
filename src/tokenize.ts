import {
  type File,
  type Token,
  TokenKind,
  type Type,
  arrayOf,
  tyChar,
  tyDouble,
  tyFloat,
  tyInt,
  tyLdouble,
  tyLong,
  tyUchar,
  tyUint,
  tyUlong,
  tyUshort,
  tyShort,
} from "./ctypes.js";
import { error, errorAt, errorTok, setCurrentFile } from "./diag.js";
import { encodeUtf8CodePoint, isIdent1, isIdent2, nextCodePoint } from "./unicode.js";
import { readFileSync } from "node:fs";

/** Lexer: UTF-8 aware identifiers, preprocessor numbers, literals, and token utilities. */

let currentFile: File;
let atBol = true;
let hasSpace = false;

const inputFiles: File[] = [];

/** All source {@link File} records registered by {@link tokenizeFile} this session. */
export function getInputFiles(): File[] {
  return inputFiles;
}

/** Source slice for token `t` (same as `contents.slice(loc, loc+len)`). */
function tokText(t: Token): string {
  return t.file.contents.slice(t.loc, t.loc + t.len);
}

/** True if `tok` spans exactly the punctuator or keyword text `op`. */
export function equal(tok: Token, op: string): boolean {
  return tok.len === op.length && tok.file.contents.slice(tok.loc, tok.loc + tok.len) === op;
}

/** Consumes `op` or {@link errorTok}; returns the following token. */
export function skip(tok: Token, op: string): Token {
  if (!equal(tok, op)) errorTok(tok, "expected '%s'", op);
  return tok.next!;
}

/**
 * If `tok` matches `str`, advances `rest.current` and returns true; otherwise leaves `rest.current` at `tok`.
 */
export function consume(rest: { current: Token | null }, tok: Token, str: string): boolean {
  if (equal(tok, str)) {
    rest.current = tok.next;
    return true;
  }
  rest.current = tok;
  return false;
}

const KW = new Set([
  "return",
  "if",
  "else",
  "for",
  "while",
  "int",
  "sizeof",
  "char",
  "struct",
  "union",
  "short",
  "long",
  "void",
  "typedef",
  "_Bool",
  "enum",
  "static",
  "goto",
  "break",
  "continue",
  "switch",
  "case",
  "default",
  "extern",
  "_Alignof",
  "_Alignas",
  "do",
  "signed",
  "unsigned",
  "const",
  "volatile",
  "auto",
  "register",
  "restrict",
  "__restrict",
  "__restrict__",
  "_Noreturn",
  "float",
  "double",
  "typeof",
  "asm",
  "_Thread_local",
  "__thread",
  "_Atomic",
  "__attribute__",
]);

/** True if `s` is a reserved word for this compiler's keyword set. */
function isKeywordText(s: string): boolean {
  return KW.has(s);
}

/** Builds a token on `currentFile` at `[start, end)` with current BOL/space flags. */
function newToken(kind: TokenKind, start: number, end: number): Token {
  const tok: Token = {
    kind,
    next: null,
    val: 0n,
    fval: 0,
    loc: start,
    len: end - start,
    ty: null,
    str: null,
    file: currentFile,
    filename: currentFile.displayName,
    lineNo: 1,
    lineDelta: 0,
    atBol,
    hasSpace,
  };
  atBol = false;
  hasSpace = false;
  return tok;
}

/** True if `s` has prefix `q` at code unit index `i`. */
function startswith(s: string, i: number, q: string): boolean {
  return s.slice(i, i + q.length) === q;
}

/** Byte length of a C11 identifier starting at `start`, or 0 if not an identifier. */
function readIdentLen(s: string, start: number): number {
  const { cp, next } = nextCodePoint(s, start);
  if (!isIdent1(cp)) return 0;
  let p = next;
  for (;;) {
    const r = nextCodePoint(s, p);
    if (!isIdent2(r.cp)) return p - start;
    p = r.next;
  }
}

/** Single hex digit to 0–15. */
function fromHex(c: string): number {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "a" && c <= "f") return c.charCodeAt(0) - 87;
  return c.charCodeAt(0) - 55;
}

const LONG_PUNCT = [
  "<<=",
  ">>=",
  "...",
  "==",
  "!=",
  "<=",
  ">=",
  "->",
  "+=",
  "-=",
  "*=",
  "/=",
  "++",
  "--",
  "%=",
  "&=",
  "|=",
  "^=",
  "&&",
  "||",
  "<<",
  ">>",
  "##",
];

/** Longest punctuator match at `i` (multi-char operators first), else 0. */
function readPunctLen(s: string, i: number): number {
  for (const kw of LONG_PUNCT) {
    if (startswith(s, i, kw)) return kw.length;
  }
  const c = s[i];
  if (/[()[\]{}.?,;:&|*^%+-/<>!=~#]/.test(c)) return 1;
  return 0;
}

/** Parses one char/escape after `\\` in a char or string literal; returns code point and index past it. */
function readEscapedChar(s: string, i: number): { c: number; next: number } {
  const ch = s[i];
  if (ch >= "0" && ch <= "7") {
    let p = i;
    let c = s.charCodeAt(p++) - 48;
    if (p < s.length && s[p] >= "0" && s[p] <= "7") c = (c << 3) + (s.charCodeAt(p++) - 48);
    if (p < s.length && s[p] >= "0" && s[p] <= "7") c = (c << 3) + (s.charCodeAt(p++) - 48);
    return { c, next: p };
  }
  if (ch === "x") {
    let p = i + 1;
    if (p >= s.length || !/[0-9a-fA-F]/.test(s[p])) errorAt(i, "invalid hex escape sequence");
    let c = 0;
    while (p < s.length && /[0-9a-fA-F]/.test(s[p])) c = (c << 4) + fromHex(s[p++]);
    return { c, next: p };
  }
  const p = i + 1;
  switch (ch) {
    case "a":
      return { c: 7, next: p };
    case "b":
      return { c: 8, next: p };
    case "t":
      return { c: 9, next: p };
    case "n":
      return { c: 10, next: p };
    case "v":
      return { c: 11, next: p };
    case "f":
      return { c: 12, next: p };
    case "r":
      return { c: 13, next: p };
    case "e":
      return { c: 27, next: p };
    default:
      return { c: ch.charCodeAt(0), next: p };
  }
}

/** Index of closing `"` for a string starting at `start` (after opening quote). */
function stringLiteralEnd(s: string, start: number): number {
  let p = start;
  while (p < s.length && s[p] !== '"') {
    if (s[p] === "\n" || s[p] === "\0") errorAt(start, "unclosed string literal");
    if (s[p] === "\\") p++;
    p++;
  }
  return p;
}

/** String literal token: UTF-8 payload in `str`, `ty` is `char[N]` including implicit NUL width. */
function readStringLiteral(start: number, quote: number): Token {
  const end = stringLiteralEnd(currentFile.contents, quote + 1);
  const bytes: number[] = [];
  let p = quote + 1;
  while (p < end) {
    if (currentFile.contents[p] === "\\") {
      const r = readEscapedChar(currentFile.contents, p + 1);
      const enc = encodeUtf8CodePoint(r.c);
      bytes.push(...enc);
      p = r.next;
    } else {
      const { cp, next } = nextCodePoint(currentFile.contents, p);
      const enc = encodeUtf8CodePoint(cp);
      bytes.push(...enc);
      p = next;
    }
  }
  const tok = newToken(TokenKind.Str, start, end + 1);
  tok.ty = arrayOf(tyChar, bytes.length + 1);
  tok.str = new Uint8Array(bytes);
  return tok;
}

/** Character constant token; value narrowed according to `ty` (e.g. `int` vs `unsigned`). */
function readCharLiteral(start: number, quote: number, ty: Type): Token {
  let p = quote + 1;
  if (p >= currentFile.contents.length) errorAt(start, "unclosed char literal");
  let c: number;
  if (currentFile.contents[p] === "\\") {
    const r = readEscapedChar(currentFile.contents, p + 1);
    c = r.c;
    p = r.next;
  } else {
    const r = nextCodePoint(currentFile.contents, p);
    c = r.cp;
    p = r.next;
  }
  const end = currentFile.contents.indexOf("'", p);
  if (end < 0) errorAt(p, "unclosed char literal");
  const tok = newToken(TokenKind.Num, start, end + 1);
  tok.val = BigInt(c & (ty === tyInt ? 0xffffffff : 0xff));
  tok.ty = ty;
  return tok;
}

/** Parses integer literal text (decimal/hex/binary/octal) to bigint. */
function parseIntBody(body: string, baseHint: number): bigint {
  const t = body.trim();
  if (t.length >= 2 && t.slice(0, 2).toLowerCase() === "0x") return BigInt(t);
  if (t.length >= 2 && t.slice(0, 2).toLowerCase() === "0b") return BigInt(t.replace(/^0[bB]/, "0b"));
  if (baseHint === 8 && t.startsWith("0") && t.length > 1) return BigInt(parseInt(t, 8));
  if (t === "0") return 0n;
  return BigInt(t);
}

/** If `tok` is an integer pp-number, rewrites it as {@link TokenKind.Num} with suffix-derived type; else false. */
function convertPpInt(tok: Token): boolean {
  const full = tokText(tok);
  let l = false;
  let u = false;
  let j = full.length;
  const low = full.toLowerCase();
  if (low.endsWith("llu") || low.endsWith("ull")) {
    j -= 3;
    l = u = true;
  } else if (low.endsWith("lu") || low.endsWith("ul")) {
    j -= 2;
    l = u = true;
  } else if (low.endsWith("ll")) {
    j -= 2;
    l = true;
  } else if (full.endsWith("l") || full.endsWith("L")) {
    j -= 1;
    l = true;
  } else if (full.endsWith("u") || full.endsWith("U")) {
    j -= 1;
    u = true;
  }
  const numPart = full.slice(0, j);
  if (numPart.length !== full.length && /[eEpP.]/.test(numPart)) return false;

  let base = 10;
  if (numPart.length >= 2 && numPart.slice(0, 2).toLowerCase() === "0x" && /[0-9a-f]/i.test(numPart[2] ?? ""))
    base = 16;
  else if (numPart.length >= 2 && numPart.slice(0, 2).toLowerCase() === "0b" && /[01]/.test(numPart[2] ?? ""))
    base = 2;
  // Do not treat 0.5, 0e1, etc. as octal; let convertPpNumber handle floating constants.
  else if (
    numPart.startsWith("0") &&
    numPart.length > 1 &&
    base !== 16 &&
    !/[eEpP.]/.test(numPart.slice(1))
  )
    base = 8;

  let val: bigint;
  try {
    val = parseIntBody(numPart, base);
  } catch {
    return false;
  }

  let ty: Type;
  if (base === 10) {
    if (l && u) ty = tyUlong;
    else if (l) ty = tyLong;
    else if (u) ty = val >> 32n ? tyUlong : tyUint;
    else ty = val >> 31n ? tyLong : tyInt;
  } else {
    if (l && u) ty = tyUlong;
    else if (l) ty = val >> 63n ? tyUlong : tyLong;
    else if (u) ty = val >> 32n ? tyUlong : tyUint;
    else if (val >> 63n) ty = tyUlong;
    else if (val >> 32n) ty = tyLong;
    else if (val >> 31n) ty = tyUint;
    else ty = tyInt;
  }

  tok.kind = TokenKind.Num;
  tok.val = val;
  tok.ty = ty;
  return true;
}

/** Converts a preprocessor number token to typed {@link TokenKind.Num} (integer or float). */
function convertPpNumber(tok: Token): void {
  if (convertPpInt(tok)) return;
  const slice = tokText(tok);
  const m = slice.match(/^([0-9.]+(?:[eEpP][+-]?[0-9]+)?)([flFL]*)$/);
  if (!m) errorTok(tok, "invalid numeric constant");
  const n = m[1];
  const suf = (m[2] || "").toLowerCase();
  const val = parseFloat(n);
  let ty: Type;
  if (suf.includes("f")) ty = tyFloat;
  else if (suf.includes("l")) ty = tyLdouble;
  else ty = tyDouble;
  tok.kind = TokenKind.Num;
  tok.fval = val;
  tok.ty = ty;
}

/** After preprocessing: classify id keywords and normalize all `PpNum` tokens. */
export function convertPpTokens(tok: Token | null): void {
  for (let t = tok; t && t.kind !== TokenKind.Eof; t = t.next!) {
    const tx = tokText(t);
    if (t.kind === TokenKind.Ident && isKeywordText(tx)) t.kind = TokenKind.Keyword;
    else if (t.kind === TokenKind.PpNum) convertPpNumber(t);
  }
}

/** Fills `lineNo` on each token from newlines in `currentFile.contents`. */
function addLineNumbers(head: Token | null): void {
  const input = currentFile.contents;
  let n = 1;
  let p = 0;
  let tok = head;
  while (p < input.length && tok) {
    if (p === tok.loc) {
      tok.lineNo = n + currentFile.lineDelta;
      tok = tok.next!;
    }
    if (input[p] === "\n") n++;
    p++;
  }
}

/**
 * Lexes `file.contents` into a singly linked token list ending in {@link TokenKind.Eof}.
 * Sets {@link setCurrentFile} for diagnostics.
 */
export function tokenize(file: File): Token {
  currentFile = file;
  setCurrentFile(file);
  const s = file.contents;
  let p = 0;
  const head: Token = newToken(TokenKind.Eof, 0, 0);
  let cur: Token = head;

  atBol = true;
  hasSpace = false;

  while (p < s.length) {
    if (startswith(s, p, "//")) {
      p += 2;
      while (p < s.length && s[p] !== "\n") p++;
      hasSpace = true;
      continue;
    }
    if (startswith(s, p, "/*")) {
      const q = s.indexOf("*/", p + 2);
      if (q < 0) errorAt(p, "unclosed block comment");
      p = q + 2;
      hasSpace = true;
      continue;
    }
    if (s[p] === "\n") {
      p++;
      atBol = true;
      hasSpace = false;
      continue;
    }
    if (/\s/.test(s[p])) {
      p++;
      hasSpace = true;
      continue;
    }

    if (/[0-9]/.test(s[p]) || (s[p] === "." && p + 1 < s.length && /[0-9]/.test(s[p + 1]))) {
      const q = p++;
      while (p < s.length) {
        if (s[p - 1] && /[eEpP]/.test(s[p - 1]) && /[+-]/.test(s[p])) {
          p++;
          continue;
        }
        if (/[0-9a-zA-Z_.]/.test(s[p])) p++;
        else break;
      }
      cur = cur.next = newToken(TokenKind.PpNum, q, p);
      continue;
    }

    if (s[p] === '"') {
      cur = cur.next = readStringLiteral(p, p);
      p = cur.loc + cur.len;
      continue;
    }
    if (startswith(s, p, 'u8"')) {
      cur = cur.next = readStringLiteral(p, p + 2);
      p = cur.loc + cur.len;
      continue;
    }

    if (s[p] === "'") {
      cur = cur.next = readCharLiteral(p, p, tyInt);
      cur.val = BigInt(Number(cur.val) & 0xff);
      p = cur.loc + cur.len;
      continue;
    }
    if (startswith(s, p, "u'")) {
      cur = cur.next = readCharLiteral(p, p + 1, tyUshort);
      cur.val = cur.val & 0xffffn;
      p = cur.loc + cur.len;
      continue;
    }
    if (startswith(s, p, "L'")) {
      cur = cur.next = readCharLiteral(p, p + 1, tyInt);
      p = cur.loc + cur.len;
      continue;
    }
    if (startswith(s, p, "U'")) {
      cur = cur.next = readCharLiteral(p, p + 1, tyUint);
      p = cur.loc + cur.len;
      continue;
    }

    const ilen = readIdentLen(s, p);
    if (ilen) {
      cur = cur.next = newToken(TokenKind.Ident, p, p + ilen);
      p += ilen;
      continue;
    }

    const plen = readPunctLen(s, p);
    if (plen) {
      cur = cur.next = newToken(TokenKind.Punct, p, p + plen);
      p += plen;
      continue;
    }

    errorAt(p, "invalid token");
  }

  cur.next = newToken(TokenKind.Eof, p, p);
  addLineNumbers(head.next);
  return head.next!;
}

/** Normalizes CRLF/CR to LF. */
function canonicalizeNewline(p: string): string {
  return p.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Removes backslash-newline splicing before lexing. */
function removeBackslashNewline(p: string): string {
  return p.replace(/\\\n/g, "");
}

/** Expands `\\uXXXX` and `\\UXXXXXXXX` to UTF-16 code units in the source string. */
function convertUniversalChars(p: string): string {
  let out = "";
  let i = 0;
  while (i < p.length) {
    if (p.slice(i, i + 2) === "\\u" && /^[0-9a-fA-F]{4}/.test(p.slice(i + 2, i + 6))) {
      const c = parseInt(p.slice(i + 2, i + 6), 16);
      out += String.fromCodePoint(c);
      i += 6;
    } else if (p.slice(i, i + 2) === "\\U" && /^[0-9a-fA-F]{8}/.test(p.slice(i + 2, i + 10))) {
      const c = parseInt(p.slice(i + 2, i + 10), 16);
      out += String.fromCodePoint(c);
      i += 10;
    } else {
      out += p[i++];
    }
  }
  return out;
}

/**
 * Normalizes source text for lexing (newlines, splice, UCN) and ensures a trailing newline.
 * @param fileNo Stable id for diagnostics and include ordering.
 */
export function newFile(name: string, fileNo: number, contents: string): File {
  let c = canonicalizeNewline(contents);
  c = removeBackslashNewline(c);
  c = convertUniversalChars(c);
  if (c.length === 0 || c[c.length - 1] !== "\n") c += "\n";
  return { name, displayName: name, fileNo, contents: c, lineDelta: 0 };
}

let fileCounter = 0;

/**
 * Reads `path` (or uses `contents`), registers the file, and returns the token stream head.
 * @returns `null` on I/O failure instead of throwing.
 */
export function tokenizeFile(path: string, contents?: string): Token | null {
  try {
    const text = contents ?? readFileSync(path, "utf8");
    let c = text;
    if (c.startsWith("\ufeff")) c = c.slice(1);
    const file = newFile(path, ++fileCounter, c);
    inputFiles.push(file);
    return tokenize(file);
  } catch {
    return null;
  }
}

/** Concatenates two chains: last non-Eof of `tok1` points at `tok2`. */
export function appendTokens(tok1: Token | null, tok2: Token | null): Token | null {
  if (!tok1 || tok1.kind === TokenKind.Eof) return tok2;
  let t = tok1;
  while (t.next && t.next.kind !== TokenKind.Eof) t = t.next;
  t.next = tok2;
  return tok1;
}
