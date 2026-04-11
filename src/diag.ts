import type { File } from "./ctypes.js";
import { displayWidth } from "./unicode.js";
import type { Token } from "./ctypes.js";

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

let currentFile: File | null = null;

export function setCurrentFile(f: File | null): void {
  currentFile = f;
}

export function error(fmt: string, ...args: unknown[]): never {
  const msg = formatMsg(fmt, args);
  console.error(msg);
  throw new CompileError(msg);
}

function formatMsg(fmt: string, args: unknown[]): string {
  let i = 0;
  return fmt.replace(/%[sd]/g, () => String(args[i++] ?? ""));
}

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

export function errorAt(loc: number, fmt: string, ...args: unknown[]): never {
  if (!currentFile) error(fmt, ...args);
  const input = currentFile.contents;
  let lineNo = 1;
  for (let p = 0; p < loc; p++) if (input[p] === "\n") lineNo++;
  const msg = formatMsg(fmt, args);
  verrorAt(currentFile.name, input, lineNo, loc, msg);
  throw new CompileError(msg);
}

export function errorTok(tok: Token, fmt: string, ...args: unknown[]): never {
  const msg = formatMsg(fmt, args);
  verrorAt(tok.file.name, tok.file.contents, tok.lineNo, tok.loc, msg);
  throw new CompileError(msg);
}

export function warnTok(tok: Token, fmt: string, ...args: unknown[]): void {
  const msg = formatMsg(fmt, args);
  verrorAt(tok.file.name, tok.file.contents, tok.lineNo, tok.loc, msg);
}
