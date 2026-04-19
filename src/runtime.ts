/**
 * Isolated execution: compile emitted JS with vm, expose I/O via host hooks.
 */

import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import vm from "node:vm";
import type { Layout } from "./jsCodegen.js";

export type HostHooks = {
  /** Default: line to stdout via console.log */
  log: (line: string) => void;
  /**
   * One line of stdin (no trailing newline), used by scanf.
   * If omitted, scanf matches no conversions and returns 0.
   */
  readLine?: () => string;
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

/**
 * One readLine per call; parses %d / %i / %u (whitespace-separated tokens).
 * Returns one bigint per conversion; used by codegen so stack locals are assigned in JS instead of via fake addresses.
 */
function scanfReadValues(mem: Uint8Array, hooks: HostHooks, fmtAddr: bigint): bigint[] {
  const fmt = readCString(mem, fmtAddr);
  const line = hooks.readLine?.() ?? "";
  const tokens = line.trim().length === 0 ? [] : line.trim().split(/\s+/);
  let ti = 0;
  const values: bigint[] = [];
  for (let i = 0; i < fmt.length; ) {
    if (fmt[i] === "%" && i + 1 < fmt.length) {
      const c = fmt[++i];
      if (c === "d" || c === "i") {
        const tok = tokens[ti++] ?? "0";
        const parsed = Number.parseInt(tok, 10);
        const n = Number.isFinite(parsed) ? parsed | 0 : 0;
        values.push(BigInt(n));
      } else if (c === "u") {
        const tok = tokens[ti++] ?? "0";
        const parsed = Number.parseInt(tok, 10);
        const n = Number.isFinite(parsed) ? parsed >>> 0 : 0;
        values.push(BigInt(n));
      } else if (c === "%") {
        i++;
      }
      i++;
    } else if (/\s/.test(fmt[i]!)) {
      i++;
    } else {
      i++;
    }
  }
  return values;
}

export function createRuntime(mem: Uint8Array, hooks: HostHooks, heapBase: number) {
  let heapPtr = alignTo(heapBase, 16);
  /** POSIX-style PRNG state (glibc-style LCG). */
  let randState = 1;
  /** One view for the whole linear memory; avoids per-load/store DataView allocation. */
  const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
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
    if (size === 1) return BigInt(mem[i]!);
    if (size === 2) return BigInt(dv.getInt16(i, true));
    if (size === 4) return BigInt(dv.getInt32(i, true));
    return dv.getBigUint64(i, true);
  };

  const store = (addr: bigint, val: bigint, size: number): bigint => {
    const i = Number(addr);
    if (size === 1) mem[i] = Number(val) & 0xff;
    else if (size === 2) dv.setInt16(i, Number(val), true);
    else if (size === 4) dv.setInt32(i, Number(val), true);
    else dv.setBigUint64(i, val, true);
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

  const scanfParsed = (fmtAddr: bigint) => scanfReadValues(mem, hooks, fmtAddr);

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

  /** Host-backed FILE* slots: first u32 LE at FILE* is slot id; second u32 is magic 0x46494c45 ('FILE'). */
  type FileSlot = { fd: number; pos: number };
  const fileSlots = new Map<number, FileSlot>();
  let nextFileSlotId = 1;

  const readFileSlotId = (stream: bigint): number | null => {
    const i = Number(stream);
    if (i <= 0 || i + 8 > mem.length) return null;
    const id = dv.getUint32(i, true);
    const magic = dv.getUint32(i + 4, true);
    if (magic !== 0x46494c45) return null;
    if (!fileSlots.has(id)) return null;
    return id;
  };

  const mapOpenMode = (modeRaw: string): string | null => {
    const m = modeRaw.trim().toLowerCase();
    if (m === "r" || m === "rb" || m === "rt") return "r";
    if (m === "r+" || m === "rb+" || m === "r+b" || m === "r+t") return "r+";
    if (m === "w" || m === "wb" || m === "wt") return "w";
    if (m === "w+" || m === "wb+" || m === "w+b" || m === "w+t") return "w+";
    if (m === "a" || m === "ab" || m === "at") return "a";
    if (m === "a+" || m === "ab+" || m === "a+b" || m === "a+t") return "a+";
    return null;
  };

  const fopen = (pathAddr: bigint, modeAddr: bigint) => {
    const path = readCString(mem, pathAddr);
    const mode = readCString(mem, modeAddr);
    const flags = mapOpenMode(mode);
    if (!flags) {
      hooks.log(`[nodec] fopen: unsupported mode ${JSON.stringify(mode)}`);
      return 0n;
    }
    let fd: number;
    try {
      fd = openSync(path, flags);
    } catch (e) {
      hooks.log(`[nodec] fopen: ${e instanceof Error ? e.message : String(e)}`);
      return 0n;
    }
    const id = nextFileSlotId++;
    let pos = 0;
    if (flags === "a" || flags === "a+") {
      try {
        pos = fstatSync(fd).size;
      } catch {
        pos = 0;
      }
    }
    fileSlots.set(id, { fd, pos });
    const slotPtr = malloc(8n);
    if (slotPtr === 0n) {
      closeSync(fd);
      fileSlots.delete(id);
      return 0n;
    }
    const off = Number(slotPtr);
    dv.setUint32(off, id >>> 0, true);
    dv.setUint32(off + 4, 0x46494c45, true);
    return slotPtr;
  };

  const fclose = (stream: bigint) => {
    const id = readFileSlotId(stream);
    if (id === null) return -1n;
    const slot = fileSlots.get(id)!;
    try {
      closeSync(slot.fd);
    } catch {
      /* ignore */
    }
    fileSlots.delete(id);
    return 0n;
  };

  const fread = (ptr: bigint, size: bigint, nmemb: bigint, stream: bigint) => {
    const id = readFileSlotId(stream);
    if (id === null) return 0n;
    const slot = fileSlots.get(id)!;
    const sz = Number(size);
    const n = Number(nmemb);
    if (sz <= 0 || n <= 0) return 0n;
    let totalBytes = sz * n;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0n;
    totalBytes = Math.min(totalBytes, 64 * 1024 * 1024);
    const p = Number(ptr);
    if (p < 0 || p >= mem.length) return 0n;
    totalBytes = Math.min(totalBytes, mem.length - p);
    let got = 0;
    while (got < totalBytes) {
      const chunk = Math.min(65536, totalBytes - got);
      const buf = Buffer.alloc(chunk);
      let br: number;
      try {
        br = readSync(slot.fd, buf, 0, chunk, slot.pos);
      } catch {
        return BigInt(Math.trunc(got / sz));
      }
      if (br <= 0) break;
      mem.set(buf.subarray(0, br), p + got);
      slot.pos += br;
      got += br;
      if (br < chunk) break;
    }
    return BigInt(Math.trunc(got / sz));
  };

  const fwrite = (ptr: bigint, size: bigint, nmemb: bigint, stream: bigint) => {
    const id = readFileSlotId(stream);
    if (id === null) return 0n;
    const slot = fileSlots.get(id)!;
    const sz = Number(size);
    const n = Number(nmemb);
    if (sz <= 0 || n <= 0) return 0n;
    let totalBytes = sz * n;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0n;
    totalBytes = Math.min(totalBytes, 64 * 1024 * 1024);
    const p = Number(ptr);
    if (p < 0 || p >= mem.length) return 0n;
    totalBytes = Math.min(totalBytes, mem.length - p);
    let sent = 0;
    while (sent < totalBytes) {
      const chunk = Math.min(65536, totalBytes - sent);
      const slice = mem.subarray(p + sent, p + sent + chunk);
      const buf = Buffer.from(slice);
      let bw: number;
      try {
        bw = writeSync(slot.fd, buf, 0, chunk, slot.pos);
      } catch {
        return BigInt(Math.trunc(sent / sz));
      }
      if (bw <= 0) break;
      slot.pos += bw;
      sent += bw;
      if (bw < chunk) break;
    }
    return BigInt(Math.trunc(sent / sz));
  };

  const fseek = (stream: bigint, offset: bigint, whence: bigint) => {
    const id = readFileSlotId(stream);
    if (id === null) return -1n;
    const slot = fileSlots.get(id)!;
    const w = Number(whence);
    const off = Number(offset);
    if (!Number.isFinite(off)) return -1n;
    try {
      if (w === 0) slot.pos = Math.max(0, Math.trunc(off));
      else if (w === 1) slot.pos = Math.max(0, slot.pos + Math.trunc(off));
      else if (w === 2) {
        const st = fstatSync(slot.fd);
        slot.pos = Math.max(0, st.size + Math.trunc(off));
      } else return -1n;
    } catch {
      return -1n;
    }
    return 0n;
  };

  const ftell = (stream: bigint) => {
    const id = readFileSlotId(stream);
    if (id === null) return -1n;
    return BigInt(fileSlots.get(id)!.pos);
  };

  const fflush = (stream: bigint) => {
    if (stream === 0n) return 0n;
    if (readFileSlotId(stream) === null) return -1n;
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
      if (i >= 0 && i + 8 <= mem.length) dv.setBigUint64(i, sec, true);
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
    scanfParsed,
    malloc,
    free,
    srand,
    rand,
    time,
    sleep,
    fopen,
    fclose,
    fread,
    fwrite,
    fseek,
    ftell,
    fflush,
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
