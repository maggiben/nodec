import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tokenizeFile } from "./tokenize.js";
import { preprocess, type IncludeContext } from "./preprocess.js";
import { parse } from "./parse.js";
import { codegen } from "./jsCodegen.js";
import { runInVm, type HostHooks } from "./runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function defaultIncludePaths(sourceFile: string): string[] {
  const base = dirname(resolve(sourceFile));
  return [resolve(__dirname, "../include"), resolve(base), resolve(__dirname, "../../include")];
}

export function compileSource(filename: string, contents: string, includePaths: string[]) {
  let tok = tokenizeFile(filename, contents);
  if (!tok) throw new Error(`failed to tokenize ${filename}`);
  const ctx: IncludeContext = { includePaths };
  tok = preprocess(tok, ctx);
  const prog = parse(tok);
  return codegen(prog);
}

export function compileFile(path: string, includePaths?: string[]) {
  const contents = readFileSync(path, "utf8");
  return compileSource(path, contents, includePaths ?? defaultIncludePaths(path));
}

export function runCompiled(path: string, hooks: HostHooks, includePaths?: string[]): { exitCode: bigint } {
  const { source, layout } = compileFile(path, includePaths);
  const mod = runInVm(source, layout, hooks) as Record<string, (...a: bigint[]) => bigint>;
  const main = mod["fn_main"];
  if (typeof main !== "function") throw new Error("no defined main()");
  const exitCode = main();
  return { exitCode };
}
