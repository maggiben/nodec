#!/usr/bin/env node
import { runCompiled, compileFile, defaultIncludePaths } from "./compile.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
  const hooks = { log: (line: string) => console.log(line) };
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
