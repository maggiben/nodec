#!/usr/bin/env node
/**
 * Compare nodec-compiled C vs hand-written JavaScript on the same Node/V8 process.
 *
 * Run from repo root: npm run bench
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { compileSource, defaultIncludePaths } from "../dist/compile.js";
import { createRuntime } from "../dist/runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const benchCPath = resolve(repoRoot, "examples/bench_sum.c");
const inceptionCPath = resolve(repoRoot, "examples/mjs_inception_full.c");
const N = 1_000_000;

function expectedChecksum(n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += i % 256;
  return sum % 251;
}

function bench(name, fn, n = N, iterations = 7) {
  const exp = expectedChecksum(n);
  for (let w = 0; w < 2; w++) {
    const r = fn();
    if (r !== exp) throw new Error(`${name}: checksum ${r} !== expected ${exp} (n=${n})`);
  }
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const r = fn();
    times.push(performance.now() - t0);
    if (r !== exp) throw new Error(`${name}: wrong result`);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)];
  return { name, n, iterations, medianMs: med, checksum: exp };
}

function benchExitCode(name, fn, expected = 0, iterations = 5) {
  for (let w = 0; w < 1; w++) {
    const r = fn();
    if (r !== expected) throw new Error(`${name}: exit ${r} !== expected ${expected}`);
  }
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const r = fn();
    times.push(performance.now() - t0);
    if (r !== expected) throw new Error(`${name}: wrong exit code`);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)];
  return { name, iterations, medianMs: med, expected };
}

function runNodecBench() {
  const src = readFileSync(benchCPath, "utf8");
  const { source, layout } = compileSource(benchCPath, src, defaultIncludePaths(benchCPath));
  const script = new vm.Script(source, { filename: "bench-generated.js" });
  const hooks = { log: () => {} };
  return () => {
    const mem = Uint8Array.from(layout.memory);
    const __rt = createRuntime(mem, hooks, layout.heapBase);
    const sandbox = Object.create(null);
    const factory = script.runInNewContext(sandbox, { timeout: 120_000 });
    const mod = factory(__rt);
    return Number(mod.fn_main());
  };
}

function runNodecInceptionBench() {
  const src = readFileSync(inceptionCPath, "utf8");
  const { source, layout } = compileSource(inceptionCPath, src, defaultIncludePaths(inceptionCPath));
  const script = new vm.Script(source, { filename: "inception-generated.js" });
  const hooks = { log: () => {} };
  return () => {
    const mem = Uint8Array.from(layout.memory);
    const __rt = createRuntime(mem, hooks, layout.heapBase);
    const sandbox = Object.create(null);
    const factory = script.runInNewContext(sandbox, { timeout: 120_000 });
    const mod = factory(__rt);
    return Number(mod.fn_main());
  };
}

/** Best-practice hot loop: monomorphic TypedArray indexing (upper bound for this style of work in JS). */
function runPlainUint8Array() {
  return () => {
    const mem = new Uint8Array(N);
    for (let i = 0; i < N; i++) mem[i] = i % 256;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += mem[i];
    return sum % 251;
  };
}

/**
 * Anti-pattern: allocate a fresh DataView on every store and every load.
 * Before nodec's runtime cached a single DataView, its load/store helpers did this internally,
 * so this line is a fair "what naive host code costs" reference — not idiomatic JS.
 */
function runPerAccessDataView() {
  return () => {
    const mem = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint8(i, i % 256);
    }
    let sum = 0;
    for (let i = 0; i < N; i++) {
      sum += new DataView(mem.buffer, mem.byteOffset, mem.byteLength).getUint8(i);
    }
    return sum % 251;
  };
}

const rows = [];
rows.push(bench("nodec C (linear memory + emitted loop)", runNodecBench()));
rows.push(bench("Plain JS (Uint8Array index, same algorithm)", runPlainUint8Array()));
rows.push(bench("JS anti-pattern (new DataView per store & load)", runPerAccessDataView(), N, 5));
const inceptionRow = benchExitCode("Inception stack (Node -> nodec -> mjs)", runNodecInceptionBench(), 0, 5);

console.log(`N = ${N}, checksum ≡ ${rows[0].checksum} (mod 251)`);
console.log("");
console.log("Median wall time per run (same V8 / same machine):");
for (const r of rows) {
  console.log(`  ${r.medianMs.toFixed(2).padStart(8)} ms  ${r.name}  [n=${r.iterations}]`);
}
const [nodec, plain, anti] = rows;
console.log("");
console.log(
  `Plain TypedArray JS is ${(nodec.medianMs / plain.medianMs).toFixed(1)}× faster than nodec here — that is expected: no BigInt locals, no __rt.load/store calls, no C compilation in the timed inner loop (the harness caches vm.Script).`,
);
console.log(
  `nodec is ${(anti.medianMs / nodec.medianMs).toFixed(2)}× faster than JavaScript written with a fresh DataView on every memory access (same algorithm, same N).`,
);
console.log(
  "Takeaway: interpreted-through-JS C is not magic vs tuned JS, but a tight linear-memory lowering plus a sane runtime beats JS that repeats expensive host allocations in the hot path.",
);
console.log("");
console.log("Inception benchmark:");
console.log(
  `  ${inceptionRow.medianMs.toFixed(2).padStart(8)} ms  ${inceptionRow.name}  [n=${inceptionRow.iterations}, exit=${inceptionRow.expected}]`,
);
