#!/usr/bin/env node
import { runCompiled, compileFile, defaultIncludePaths } from "./compile.js";
import { readSync } from "node:fs";
import { resolve } from "node:path";

/** Blocking read of one line from fd 0 (for scanf in the VM). */
function readLineSync(): string {
  const chunks: number[] = [];
  const buf = Buffer.alloc(1);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch {
      break;
    }
    if (n === 0) break;
    const c = buf[0]!;
    if (c === 10) break;
    if (c === 13) continue;
    chunks.push(c);
  }
  const line = Buffer.from(chunks).toString("utf8");
  return line;
}

const argv = process.argv.slice(2);

function usage(): never {
  console.error(`nodec — TypeScript C compiler (JS backend)
Usage:
  nodec run <file.c>     Compile and run in an isolated vm (stdio → host log)
  nodec emit-js <file.c> Write generated JS to stdout
`);
  process.exit(1);
}

if (argv.length < 2) usage();

const cmd = argv[0];
const file = resolve(argv[1]!);

if (cmd === "run") {
  const hooks = { log: (line: string) => console.log(line), readLine: readLineSync };
  try {
    const { exitCode } = runCompiled(file, hooks, defaultIncludePaths(file));
    process.exit(Number(exitCode));
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
} else if (cmd === "emit-js") {
  try {
    const { source } = compileFile(file, defaultIncludePaths(file));
    process.stdout.write(source + "\n");
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
} else usage();
