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

/** NUL-terminated UTF-8 string at `addr` in `mem` (empty on out-of-range). */
function readCString(mem: Uint8Array, addr: bigint): string {
  let i = Number(addr);
  if (i < 0 || i >= mem.length) return "";
  const bytes: number[] = [];
  while (i < mem.length && mem[i] !== 0) bytes.push(mem[i++]);
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** Rounds `n` up to a multiple of `a`. */
function alignTo(n: number, a: number): number {
  return Math.floor((n + a - 1) / a) * a;
}

/** Values passed to mini printf after the format pointer (ints as bigint, floats as number). */
type PrintfArg = bigint | number;

/** Coerces a printf/scanf numeric argument to `number`. */
function argToNumber(a: PrintfArg | undefined): number {
  if (a === undefined) return 0;
  return typeof a === "bigint" ? Number(a) : a;
}

/** Interprets a printf `%s` argument as a pointer address. */
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

/** Subset of `printf`: `%s` `%d` `%i` `%u` `%c` `%f` `%%` reading from linear `mem`. */
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

function writeCString(mem: Uint8Array, dstAddr: bigint, maxBytes: number, text: string): number {
  const p = Number(dstAddr);
  if (!Number.isFinite(p) || p < 0 || p >= mem.length || maxBytes <= 0) return 0;
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  const cap = Math.max(0, Math.min(maxBytes - 1, mem.length - p - 1));
  let w = 0;
  for (; w < bytes.length && w < cap; w++) mem[p + w] = bytes[w]!;
  mem[p + w] = 0;
  return w;
}

/**
 * Built-in object passed as `__rt` into generated JS: loads/stores, libc stubs, printf/scanf, FILE*, heap.
 * @param mem Shared linear memory image (mutated by generated code).
 * @param heapBase First byte index allowed for bump `malloc` (see {@link layoutProgram}).
 */
export function createRuntime(mem: Uint8Array, hooks: HostHooks, heapBase: number) {
  let heapPtr = alignTo(heapBase, 16);
  const recentCalls: string[] = [];
  /** Best-effort rand()/srand() state: mixes user seed into Math.random()-backed output. */
  let randState = 1;
  let randSalt = ((Date.now() >>> 0) ^ ((Math.random() * 0xffffffff) >>> 0)) >>> 0;
  /** One view for the whole linear memory; avoids per-load/store DataView allocation. */
  const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
  const truthy = (v: unknown) => {
    if (typeof v === "bigint") return v !== 0n;
    if (typeof v === "number") return v !== 0;
    return !!v;
  };

  const castFloat = (v: unknown): number => {
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    return Number(v as number) || 0;
  };

  const castInt = (v: unknown): bigint => {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    const n = Number(v as number);
    return BigInt(Number.isFinite(n) ? Math.trunc(n) : 0);
  };

  const eq = (a: unknown, b: unknown) => {
    if (typeof a === "bigint" && typeof b === "bigint") return a === b;
    return BigInt(Number(a as bigint)) === BigInt(Number(b as bigint));
  };

  const load = (addr: bigint, size: number): bigint => {
    const i = Number(addr);
    if (!Number.isFinite(i) || i < 0 || i + size > mem.length) return 0n;
    if (size === 1) return BigInt(mem[i]!);
    if (size === 2) return BigInt(dv.getInt16(i, true));
    if (size === 4) return BigInt(dv.getInt32(i, true));
    return dv.getBigUint64(i, true);
  };

  const loadf = (addr: bigint, size: number): number => {
    const i = Number(addr);
    if (!Number.isFinite(i) || i < 0 || i + size > mem.length) return 0;
    if (size === 4) return dv.getFloat32(i, true);
    if (size === 8) return dv.getFloat64(i, true);
    return Number(load(addr, size));
  };

  const store = (addr: bigint, val: bigint, size: number): bigint => {
    const i = Number(addr);
    if (!Number.isFinite(i) || i < 0 || i + size > mem.length) return 0n;
    if (size === 1) mem[i] = Number(val) & 0xff;
    else if (size === 2) dv.setInt16(i, Number(val), true);
    else if (size === 4) dv.setInt32(i, Number(val), true);
    else dv.setBigUint64(i, val, true);
    return val;
  };

  const storef = (addr: bigint, val: unknown, size: number): number => {
    const i = Number(addr);
    if (!Number.isFinite(i) || i < 0 || i + size > mem.length) return 0;
    const num = typeof val === "number" ? val : typeof val === "bigint" ? Number(val) : Number(val);
    if (size === 4) dv.setFloat32(i, num, true);
    else if (size === 8) dv.setFloat64(i, num, true);
    else store(addr, BigInt(Math.trunc(Number.isFinite(num) ? num : 0)), size);
    return num;
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

  const stackAlloc = (size: bigint, align: number) => {
    const n = Number(size);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    const a = Number.isFinite(align) && align > 0 ? Math.trunc(align) : 8;
    heapPtr = alignTo(heapPtr, Math.min(Math.max(a, 1), 64));
    const start = heapPtr;
    heapPtr = heapPtr + Math.trunc(n);
    if (heapPtr > mem.length) return 0n;
    mem.fill(0, start, Math.min(mem.length, heapPtr));
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
    const sz = Number(size);
    const n = Number(nmemb);
    if (sz <= 0 || n <= 0) return 0n;
    let totalBytes = sz * n;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0n;
    totalBytes = Math.min(totalBytes, 64 * 1024 * 1024);
    const p = Number(ptr);
    if (p < 0 || p >= mem.length) return 0n;
    totalBytes = Math.min(totalBytes, mem.length - p);
    const id = readFileSlotId(stream);
    if (id === null) {
      const slice = mem.subarray(p, p + totalBytes);
      process.stdout.write(Buffer.from(slice));
      return BigInt(Math.trunc(totalBytes / sz));
    }
    const slot = fileSlots.get(id)!;
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
    randSalt = (randSalt ^ randState ^ ((Math.random() * 0xffffffff) >>> 0)) >>> 0;
    return 0n;
  };

  const rand = () => {
    // Build a 53-bit random value from Math.random() (the maximum precision JS exposes),
    // then fold it into a 31-bit C rand() result while mixing in srand()-driven state.
    const hi = (Math.random() * 0x4000000) >>> 0; // 26 bits
    const lo = (Math.random() * 0x8000000) >>> 0; // 27 bits
    const raw53 = hi * 0x8000000 + lo;
    const base31 = (raw53 % 0x80000000) >>> 0;

    // Keep srand() meaningful by evolving local state and xoring it into output.
    randState = (Math.imul(randState, 1664525) + 1013904223) >>> 0;
    randSalt = (randSalt ^ ((Math.random() * 0xffffffff) >>> 0)) >>> 0;

    const mixed = (base31 ^ randState ^ randSalt) & 0x7fffffff;
    return BigInt(mixed);
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

  const snprintf = (...xs: PrintfArg[]) => {
    if (xs.length < 3) return 0n;
    const dst = argToAddr(xs[0]);
    const size = Math.max(0, Math.trunc(argToNumber(xs[1])));
    const fmt = argToAddr(xs[2]);
    const out = formatPrintf(mem, fmt, xs.slice(3));
    writeCString(mem, dst, size, out);
    return BigInt(out.length);
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

  const call = (name: string, args: bigint[]) => {
    recentCalls.push(name);
    if (recentCalls.length > 16) recentCalls.shift();
    if (name === "calloc") {
      if (args.length < 2) return 0n;
      const nmemb = Number(args[0]);
      const size = Number(args[1]);
      if (!Number.isFinite(nmemb) || !Number.isFinite(size) || nmemb < 0 || size < 0) {
        hooks.log(`[nodec] calloc invalid args: nmemb=${nmemb} size=${size}`);
        return 0n;
      }
      let total = Math.max(0, Math.trunc(nmemb * size));
      // libc may return either NULL or a unique pointer for calloc(0,0). We choose
      // a stable non-NULL 1-byte allocation to keep embedded runtimes progressing.
      if (total === 0) total = 1;
      const ptr = malloc(BigInt(total));
      if (ptr === 0n) {
        hooks.log(`[nodec] calloc failed: nmemb=${nmemb} size=${size} total=${total}`);
        return 0n;
      }
      const p = Number(ptr);
      mem.fill(0, p, Math.min(mem.length, p + total));
      return ptr;
    }
    if (name === "memset") {
      if (args.length < 3) return 0n;
      const dst = Number(args[0]);
      const val = Number(args[1]) & 0xff;
      const n = Math.max(0, Math.trunc(Number(args[2])));
      if (!Number.isFinite(dst) || dst < 0 || dst >= mem.length || n <= 0) return args[0] ?? 0n;
      mem.fill(val, dst, Math.min(mem.length, dst + n));
      return args[0] ?? 0n;
    }
    if (name === "memcpy" || name === "memmove") {
      if (args.length < 3) return 0n;
      const dst = Number(args[0]);
      const src = Number(args[1]);
      const n = Math.max(0, Math.trunc(Number(args[2])));
      if (!Number.isFinite(dst) || !Number.isFinite(src) || n <= 0) return args[0] ?? 0n;
      if (dst < 0 || src < 0 || dst >= mem.length || src >= mem.length) return args[0] ?? 0n;
      const span = Math.min(n, mem.length - src, mem.length - dst);
      if (span > 0) mem.copyWithin(dst, src, src + span);
      return args[0] ?? 0n;
    }
    if (name === "memcmp") {
      if (args.length < 3) return 0n;
      const a = Number(args[0]);
      const b = Number(args[1]);
      const n = Math.max(0, Math.trunc(Number(args[2])));
      if (!Number.isFinite(a) || !Number.isFinite(b) || n <= 0) return 0n;
      const span = Math.min(n, mem.length - Math.max(0, a), mem.length - Math.max(0, b));
      for (let i = 0; i < span; i++) {
        const av = mem[a + i]!;
        const bv = mem[b + i]!;
        if (av !== bv) return BigInt(av - bv);
      }
      return 0n;
    }
    if (name === "strlen") {
      if (args.length < 1) return 0n;
      const s = readCString(mem, args[0]!);
      return BigInt(s.length);
    }
    if (name === "strcmp" || name === "strncmp") {
      if (args.length < 2) return 0n;
      const a = readCString(mem, args[0]!);
      const b = readCString(mem, args[1]!);
      const n = name === "strncmp" ? Math.max(0, Math.trunc(Number(args[2] ?? 0n))) : Math.max(a.length, b.length);
      const aa = a.slice(0, n);
      const bb = b.slice(0, n);
      if (aa === bb) return 0n;
      return BigInt(aa < bb ? -1 : 1);
    }
    if (name === "strcpy" || name === "strncpy") {
      if (args.length < 2) return 0n;
      const dst = Number(args[0]);
      const src = readCString(mem, args[1]!);
      if (!Number.isFinite(dst) || dst < 0 || dst >= mem.length) return args[0] ?? 0n;
      const max = name === "strncpy" ? Math.max(0, Math.trunc(Number(args[2] ?? 0n))) : src.length + 1;
      const enc = new TextEncoder();
      const bytes = enc.encode(src);
      const n = Math.min(max, mem.length - dst);
      let i = 0;
      for (; i < n && i < bytes.length; i++) mem[dst + i] = bytes[i]!;
      for (; i < n; i++) mem[dst + i] = 0;
      return args[0] ?? 0n;
    }
    if (name === "strchr" || name === "strrchr" || name === "memchr") {
      if (args.length < 2) return 0n;
      const start = Number(args[0]);
      const ch = Number(args[1]) & 0xff;
      if (!Number.isFinite(start) || start < 0 || start >= mem.length) return 0n;
      const max =
        name === "memchr"
          ? Math.max(0, Math.trunc(Number(args[2] ?? 0n)))
          : mem.length - start;
      let found = -1;
      for (let i = 0; i < max && start + i < mem.length; i++) {
        if (mem[start + i] === ch) {
          found = start + i;
          if (name !== "strrchr") break;
        }
        if (name !== "memchr" && mem[start + i] === 0) break;
      }
      return found >= 0 ? BigInt(found) : 0n;
    }
    if (name === "strspn" || name === "strcspn") {
      if (args.length < 2) return 0n;
      const s = readCString(mem, args[0]!);
      const accept = readCString(mem, args[1]!);
      const set = new Set(Array.from(accept));
      let i = 0;
      for (; i < s.length; i++) {
        const has = set.has(s[i]!);
        if ((name === "strspn" && !has) || (name === "strcspn" && has)) break;
      }
      return BigInt(i);
    }
    if (name === "strpbrk") {
      if (args.length < 2) return 0n;
      const base = Number(args[0]);
      const s = readCString(mem, args[0]!);
      const accept = new Set(Array.from(readCString(mem, args[1]!)));
      for (let i = 0; i < s.length; i++) {
        if (accept.has(s[i]!)) return BigInt(base + i);
      }
      return 0n;
    }
    if (name === "atoi") {
      if (args.length < 1) return 0n;
      const s = readCString(mem, args[0]!);
      return BigInt(Number.parseInt(s, 10) || 0);
    }
    if (name === "atol") {
      if (args.length < 1) return 0n;
      const s = readCString(mem, args[0]!);
      return BigInt(Number.parseInt(s, 10) || 0);
    }
    if (name === "atof") {
      if (args.length < 1) return 0n;
      const s = readCString(mem, args[0]!);
      const n = Number.parseFloat(s);
      return BigInt(Math.trunc(Number.isFinite(n) ? n : 0));
    }
    if (name === "realloc") {
      if (args.length < 2) return 0n;
      const oldPtr = args[0] ?? 0n;
      const size = Math.max(0, Math.trunc(Number(args[1] ?? 0n)));
      if (oldPtr === 0n) return malloc(BigInt(size));
      if (size === 0) return 0n;
      const newPtr = malloc(BigInt(size));
      if (newPtr === 0n) return 0n;
      const src = Number(oldPtr);
      const dst = Number(newPtr);
      if (src >= 0 && src < mem.length && dst >= 0 && dst < mem.length) {
        const span = Math.min(size, mem.length - src, mem.length - dst);
        if (span > 0) mem.copyWithin(dst, src, src + span);
      }
      return newPtr;
    }
    if (name === "isnan") {
      const v = Number(args[0] ?? 0n);
      return Number.isNaN(v) ? 1n : 0n;
    }
    if (name === "isinf") {
      const v = Number(args[0] ?? 0n);
      return Number.isFinite(v) ? 0n : 1n;
    }
    if (name === "abort") {
      hooks.log(`[nodec] abort() called; recent host calls: ${recentCalls.join(", ")}`);
      throw new Error("abort() called");
    }
    if (name === "snprintf") {
      return snprintf(...args);
    }
    if (name === "vsnprintf") {
      if (args.length < 3) return 0n;
      const dst = args[0] ?? 0n;
      const size = args[1] ?? 0n;
      const fmt = args[2] ?? 0n;
      const out = formatPrintf(mem, fmt, []);
      writeCString(mem, dst, Math.max(0, Math.trunc(Number(size))), out);
      return BigInt(out.length);
    }
    if (name === "fprintf") {
      if (args.length < 2) return 0n;
      const stream = args[0] ?? 0n;
      const fmt = args[1] ?? 0n;
      const line = formatPrintf(mem, fmt, args.slice(2));
      const id = readFileSlotId(stream);
      if (id === null) hooks.log(line);
      else {
        const slot = fileSlots.get(id)!;
        const buf = Buffer.from(new TextEncoder().encode(line));
        try {
          writeSync(slot.fd, buf, 0, buf.length, slot.pos);
          slot.pos += buf.length;
        } catch {
          hooks.log(line);
        }
      }
      return BigInt(line.length);
    }
    if (name === "putchar") {
      const ch = Math.trunc(Number(args[0] ?? 0n)) & 0xff;
      process.stdout.write(String.fromCharCode(ch));
      return BigInt(ch);
    }
    hooks.log(`[nodec] unimplemented host call: ${name}`);
    return 0n;
  };

  const member = (base: bigint, offset: number, size: number) => load(base + BigInt(offset), size);

  return {
    memory: mem,
    truthy,
    castFloat,
    castInt,
    eq,
    load,
    loadf,
    store,
    storef,
    storeGlobal,
    ptrAdd,
    ptrSub,
    printf,
    sprintf,
    snprintf,
    scanfParsed,
    malloc,
    stackAlloc,
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

/**
 * Clones `layout.memory`, evaluates the IIFE factory in a fresh VM context, and returns its exports (`fn_main`, …).
 */
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
