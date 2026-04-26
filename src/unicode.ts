/** C11 identifier and display width helpers. */

/** True if Unicode scalar value `c` lies in any closed pair `[range[i], range[i+1]]` until a `-1` sentinel. */
function inRange(range: number[], c: number): boolean {
  for (let i = 0; i < range.length && range[i] !== -1; i += 2) {
    if (range[i] <= c && c <= range[i + 1]) return true;
  }
  return false;
}

const IDENT1_RANGE: number[] = [
  "_".charCodeAt(0),
  "_".charCodeAt(0),
  "a".charCodeAt(0),
  "z".charCodeAt(0),
  "A".charCodeAt(0),
  "Z".charCodeAt(0),
  "$".charCodeAt(0),
  "$".charCodeAt(0),
  0x00a8,
  0x00a8,
  0x00aa,
  0x00aa,
  0x00ad,
  0x00ad,
  0x00af,
  0x00af,
  0x00b2,
  0x00b5,
  0x00b7,
  0x00ba,
  0x00bc,
  0x00be,
  0x00c0,
  0x00d6,
  0x00d8,
  0x00f6,
  0x00f8,
  0x00ff,
  0x0100,
  0x02ff,
  0x0370,
  0x167f,
  0x1681,
  0x180d,
  0x180f,
  0x1dbf,
  0x1e00,
  0x1fff,
  0x200b,
  0x200d,
  0x202a,
  0x202e,
  0x203f,
  0x2040,
  0x2054,
  0x2054,
  0x2060,
  0x206f,
  0x2070,
  0x20cf,
  0x2100,
  0x218f,
  0x2460,
  0x24ff,
  0x2776,
  0x2793,
  0x2c00,
  0x2dff,
  0x2e80,
  0x2fff,
  0x3004,
  0x3007,
  0x3021,
  0x302f,
  0x3031,
  0x303f,
  0x3040,
  0xd7ff,
  0xf900,
  0xfd3d,
  0xfd40,
  0xfdcf,
  0xfdf0,
  0xfe1f,
  0xfe30,
  0xfe44,
  0xfe47,
  0xfffd,
  0x10000,
  0x1fffd,
  0x20000,
  0x2fffd,
  0x30000,
  0x3fffd,
  0x40000,
  0x4fffd,
  0x50000,
  0x5fffd,
  0x60000,
  0x6fffd,
  0x70000,
  0x7fffd,
  0x80000,
  0x8fffd,
  0x90000,
  0x9fffd,
  0xa0000,
  0xafffd,
  0xb0000,
  0xbfffd,
  0xc0000,
  0xcfffd,
  0xd0000,
  0xdfffd,
  0xe0000,
  0xefffd,
  -1,
];

const IDENT2_EXTRA: number[] = [
  "0".charCodeAt(0),
  "9".charCodeAt(0),
  "$".charCodeAt(0),
  "$".charCodeAt(0),
  0x0300,
  0x036f,
  0x1dc0,
  0x1dff,
  0x20d0,
  0x20ff,
  0xfe20,
  0xfe2f,
  -1,
];

/** True if `c` may start a C11 identifier (ASCII letters, `$`, `_`, and Annex E ranges). */
export function isIdent1(c: number): boolean {
  return inRange(IDENT1_RANGE, c);
}

/** True if `c` may continue an identifier (same as first char plus digits and combining marks). */
export function isIdent2(c: number): boolean {
  return isIdent1(c) || inRange(IDENT2_EXTRA, c);
}

/** UTF-16 code unit index -> next index after one Unicode scalar value. */
export function nextCodePoint(s: string, i: number): { cp: number; next: number } {
  const c = s.codePointAt(i);
  if (c === undefined) return { cp: 0, next: i };
  const next = i + (c > 0xffff ? 2 : 1);
  return { cp: c, next };
}

/**
 * Terminal column width from `lineStart` to `loc` in `contents` (ASCII=1, other BMP/supplementary=2).
 * Used to align the `^` under diagnostics.
 */
export function displayWidth(contents: string, lineStart: number, loc: number): number {
  let w = 0;
  let i = lineStart;
  while (i < loc) {
    const { cp, next } = nextCodePoint(contents, i);
    i = next;
    if (cp < 0x80) w += 1;
    else w += 2;
  }
  return w;
}

/** UTF-8 byte sequence (1–4 bytes) for a single Unicode code point `c`. */
export function encodeUtf8CodePoint(c: number): number[] {
  if (c <= 0x7f) return [c];
  if (c <= 0x7ff) return [0xc0 | (c >> 6), 0x80 | (c & 0x3f)];
  if (c <= 0xffff) {
    return [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)];
  }
  return [
    0xf0 | (c >> 18),
    0x80 | ((c >> 12) & 0x3f),
    0x80 | ((c >> 6) & 0x3f),
    0x80 | (c & 0x3f),
  ];
}
