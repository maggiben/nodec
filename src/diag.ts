import type { File } from "./ctypes.js";
import { displayWidth } from "./unicode.js";
import type { Token } from "./ctypes.js";

/** Thrown when compilation fails after a diagnostic has been printed. */
export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

let currentFile: File | null = null;

/** Sets the file used for `errorAt` / line+column diagnostics. */
export function setCurrentFile(f: File | null): void {
  currentFile = f;
}

/**
 * Formats a message (`%s` / `%d` placeholders), prints to stderr, and throws {@link CompileError}.
 * @param fmt Printf-style format string.
 */
export function error(fmt: string, ...args: unknown[]): never {
  const msg = formatMsg(fmt, args);
  console.error(msg);
  throw new CompileError(msg);
}

/** Replaces `%s` and `%d` in `fmt` with stringified entries from `args`. */
function formatMsg(fmt: string, args: unknown[]): string {
  let i = 0;
  return fmt.replace(/%[sd]/g, () => String(args[i++] ?? ""));
}

/** Prints one source line and a caret at byte offset `loc` within `input`. */
function verrorAt(
  filename: string,
  input: string,
  lineNo: number,
  loc: number,
  message: string
): void {
  let lineStart = loc;
  while (lineStart > 0 && input[lineStart - 1] !== "\n") lineStart--;
  let end = loc;
  while (end < input.length && input[end] !== "\n") end++;
  const line = input.slice(lineStart, end);
  const indent = `${filename}:${lineNo}: `.length;
  const pos = displayWidth(input, lineStart, loc) + indent;
  console.error(`${filename}:${lineNo}: ${line}`);
  console.error(`${" ".repeat(pos)}^ ${message}`);
}

/**
 * Error at a byte offset in {@link setCurrentFile the current file}; falls back to {@link error} if none set.
 * @param loc 0-based index into `currentFile.contents`.
 */
export function errorAt(loc: number, fmt: string, ...args: unknown[]): never {
  if (!currentFile) error(fmt, ...args);
  const input = currentFile.contents;
  let lineNo = 1;
  for (let p = 0; p < loc; p++) if (input[p] === "\n") lineNo++;
  const msg = formatMsg(fmt, args);
  verrorAt(currentFile.name, input, lineNo, loc, msg);
  throw new CompileError(msg);
}

/** Error anchored at `tok` (uses that token's file, line, and column). */
export function errorTok(tok: Token, fmt: string, ...args: unknown[]): never {
  const msg = formatMsg(fmt, args);
  verrorAt(tok.file.name, tok.file.contents, tok.lineNo, tok.loc, msg);
  throw new CompileError(msg);
}

/** Non-fatal diagnostic at `tok` (stderr only, does not throw). */
export function warnTok(tok: Token, fmt: string, ...args: unknown[]): void {
  const msg = formatMsg(fmt, args);
  verrorAt(tok.file.name, tok.file.contents, tok.lineNo, tok.loc, msg);
}
