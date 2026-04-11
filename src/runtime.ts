/**
 * Isolated execution: compile emitted JS with vm, expose I/O via host hooks.
 */

import vm from "node:vm";
import type { Layout } from "./jsCodegen.js";

export type HostHooks = {
  /** Default: line to stdout via console.log */
  log: (line: string) => void;
};

function readCString(mem: Uint8Array, addr: bigint): string {
  let i = Number(addr);
  if (i < 0 || i >= mem.length) return "";
  const bytes: number[] = [];
  while (i < mem.length && mem[i] !== 0) bytes.push(mem[i++]);
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function alignTo(n: number, a: number): number {
  return Math.floor((n + a - 1) / a) * a;
}

/** Values passed to mini printf after the format pointer (ints as bigint, floats as number). */
type PrintfArg = bigint | number;

function argToNumber(a: PrintfArg | undefined): number {
  if (a === undefined) return 0;
  return typeof a === "bigint" ? Number(a) : a;
}

function argToAddr(a: PrintfArg | undefined): bigint {
  if (a === undefined) return 0n;
  return typeof a === "bigint" ? a : BigInt(Math.trunc(a));
}

/** C default for %f: six digits after the decimal point. */
function formatPrintfFloat(a: PrintfArg | undefined): string {
  const n = argToNumber(a);
  if (!Number.isFinite(n)) return String(n);
  return n.toFixed(6);
}

function formatPrintf(mem: Uint8Array, fmtAddr: bigint, args: PrintfArg[]): string {
  const fmt = readCString(mem, fmtAddr);
  let ai = 0;
  let out = "";
  for (let i = 0; i < fmt.length; ) {
    if (fmt[i] === "%" && i + 1 < fmt.length) {
      const c = fmt[++i];
      if (c === "s") out += readCString(mem, argToAddr(args[ai++]));
      else if (c === "d" || c === "i") out += String(argToNumber(args[ai++]));
      else if (c === "u") {
        const a = args[ai++];
        const u = typeof a === "bigint" ? a : BigInt(Math.trunc(Number(a)));
        out += String(BigInt.asUintN(32, u));
      }
      else if (c === "c") out += String.fromCharCode(Math.trunc(argToNumber(args[ai++])) & 0xff);
      else if (c === "f" || c === "F") out += formatPrintfFloat(args[ai++]);
      else if (c === "%") out += "%";
      else out += "%" + c;
      i++;
    } else {
      out += fmt[i++];
    }
  }
  return out;
}

export function createRuntime(mem: Uint8Array, hooks: HostHooks, heapBase: number) {
  let heapPtr = alignTo(heapBase, 16);
  /** POSIX-style PRNG state (glibc-style LCG). */
  let randState = 1;
  const truthy = (v: unknown) => {
    if (typeof v === "bigint") return v !== 0n;
    if (typeof v === "number") return v !== 0;
    return !!v;
  };

  const eq = (a: unknown, b: unknown) => {
    if (typeof a === "bigint" && typeof b === "bigint") return a === b;
    return BigInt(Number(a as bigint)) === BigInt(Number(b as bigint));
  };

  const load = (addr: bigint, size: number): bigint => {
    const i = Number(addr);
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    if (size === 1) return BigInt(mem[i]!);
    if (size === 2) return BigInt(v.getInt16(i, true));
    if (size === 4) return BigInt(v.getInt32(i, true));
    return v.getBigUint64(i, true);
  };

  const store = (addr: bigint, val: bigint, size: number): bigint => {
    const i = Number(addr);
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    if (size === 1) mem[i] = Number(val) & 0xff;
    else if (size === 2) v.setInt16(i, Number(val), true);
    else if (size === 4) v.setInt32(i, Number(val), true);
    else v.setBigUint64(i, val, true);
    return val;
  };

  const storeGlobal = (off: number, val: bigint, size: number) => store(BigInt(off), val, size);

  const ptrAdd = (a: bigint, b: bigint) => a + b;
  const ptrSub = (a: bigint, b: bigint) => a - b;

  const printf = (...xs: PrintfArg[]) => {
    if (xs.length === 0) return 0n;
    const line = formatPrintf(mem, xs[0] as bigint, xs.slice(1));
    hooks.log(line);
    return 0n;
  };

  /** Bump allocator: pointers are stable for the VM run; free() is a no-op. */
  const malloc = (size: bigint) => {
    const n = Number(size);
    if (n <= 0) return 0n;
    const start = heapPtr;
    heapPtr = alignTo(heapPtr + n, 16);
    if (heapPtr > mem.length) return 0n;
    return BigInt(start);
  };

  const free = (_ptr: bigint) => {
    return 0n;
  };

  const srand = (seed: bigint) => {
    const s = Number(seed) >>> 0;
    randState = s === 0 ? 1 : s;
    return 0n;
  };

  const rand = () => {
    randState = (randState * 1103515245 + 12345) & 0x7fffffff;
    return BigInt(randState);
  };

  /** Seconds since Unix epoch; if timer is non-null, writes the same value there (unsigned 64-bit LE). */
  const time = (timer: bigint) => {
    const sec = BigInt(Math.floor(Date.now() / 1000));
    if (timer !== 0n) {
      const i = Number(timer);
      const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
      if (i >= 0 && i + 8 <= mem.length) v.setBigUint64(i, sec, true);
    }
    return sec;
  };

  /** C sprintf: writes formatted UTF-8 bytes + NUL; returns length excluding NUL, or 0 on error. */
  const sprintf = (...xs: PrintfArg[]) => {
    if (xs.length < 2) return 0n;
    const bufAddr = xs[0] as bigint;
    const fmtAddr = xs[1] as bigint;
    if (bufAddr === 0n) return 0n;
    const formatted = formatPrintf(mem, fmtAddr, xs.slice(2));
    const enc = new TextEncoder();
    const bytes = enc.encode(formatted);
    let i = Number(bufAddr);
    if (i < 0 || i >= mem.length) return 0n;
    let w = 0;
    for (; w < bytes.length && i + w < mem.length - 1; w++) mem[i + w] = bytes[w]!;
    mem[i + w] = 0;
    return BigInt(w);
  };

  /** POSIX-style sleep(seconds); blocks the VM thread (Atomics.wait). */
  const sleep = (seconds: bigint) => {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return 0n;
    const ms = Math.min(Math.trunc(s * 1000), 86_400_000);
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
    return 0n;
  };

  const call = (_name: string, _args: bigint[]) => {
    hooks.log(`[nodec] unimplemented host call: ${_name}`);
    return 0n;
  };

  const member = (base: bigint, offset: number, size: number) => load(base + BigInt(offset), size);

  return {
    memory: mem,
    truthy,
    eq,
    load,
    store,
    storeGlobal,
    ptrAdd,
    ptrSub,
    printf,
    sprintf,
    malloc,
    free,
    srand,
    rand,
    time,
    sleep,
    call,
    member,
    addr: () => 0n,
  };
}

export function runInVm(source: string, layout: Layout, hooks: HostHooks): Record<string, unknown> {
  const mem = Uint8Array.from(layout.memory);
  const __rt = createRuntime(mem, hooks, layout.heapBase);
  const sandbox = Object.create(null) as object;
  const script = new vm.Script(source, { filename: "generated.js" });
  const factory = script.runInNewContext(sandbox, { timeout: 120_000 }) as (
    rt: ReturnType<typeof createRuntime>
  ) => Record<string, unknown>;
  return factory(__rt);
}
