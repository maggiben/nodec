/**
 * JavaScript backend: linear memory + functions for vm.runInNewContext.
 */

import { type Node, type Obj, type Type, NodeKind, TypeKind, tyChar } from "./ctypes.js";
import { addType } from "./typeops.js";

/** Rounds `n` up to a multiple of `a` (rodata / global layout). */
function alignTo(n: number, a: number): number {
  return Math.floor((n + a - 1) / a) * a;
}

/** Parameter name from a function type's param `Type.name` token, if any. */
function getParamIdent(t: Type): string | null {
  if (!t.name) return null;
  const tok = t.name;
  return tok.file.contents.slice(tok.loc, tok.loc + tok.len);
}

/** Ordered `Obj` parameters matching the function type's param list (for prologue emission). */
function paramsInOrder(fn: Obj): Obj[] {
  const types: Type[] = [];
  for (let p = fn.ty.params; p; p = p.next) types.push(p);
  const byName = new Map<string, Obj>();
  for (let l = fn.params; l; l = l.next) byName.set(l.name, l);
  const out: Obj[] = [];
  for (const t of types) {
    const nm = getParamIdent(t);
    if (!nm) continue;
    const o = byName.get(nm);
    if (o) out.push(o);
  }
  return out;
}

/** Runs type inference on one function body before codegen. */
function addTypesFn(fn: Obj): void {
  if (fn.body) addType(fn.body);
}

/** Walk Member* → Deref(ptr); used for p->a and p->s.f (no aggregate load). */
function memberDerefBase(n: Node, emit: (x: Node | null) => string): { ptr: string; offset: number } | null {
  let offset = 0;
  let cur: Node | null = n;
  while (cur?.kind === NodeKind.Member) {
    offset += cur.member!.offset;
    cur = cur.lhs!;
  }
  if (cur?.kind !== NodeKind.Deref) return null;
  return { ptr: emit(cur.lhs!), offset };
}

/** Recover pointer subexpression; peel Casts so int→ptr casts are not treated as pointers. */
function peelPtrExpr(n: Node | null): Node | null {
  if (!n) return null;
  if (n.kind === NodeKind.Cast) return peelPtrExpr(n.lhs);
  if (n.ty?.kind === TypeKind.Ptr) return n;
  return null;
}

function isIntegerTy(ty: Type): boolean {
  const k = ty.kind;
  return (
    k === TypeKind.Bool ||
    k === TypeKind.Char ||
    k === TypeKind.Short ||
    k === TypeKind.Int ||
    k === TypeKind.Long ||
    k === TypeKind.Enum
  );
}

/** True if this expression was integer-like before Ptr casts from ptr+int typing. */
function effectiveIntegerExpr(n: Node | null): boolean {
  if (!n?.ty) return false;
  if (isIntegerTy(n.ty)) return true;
  if (n.kind === NodeKind.Cast && n.lhs?.ty && isIntegerTy(n.lhs.ty)) return true;
  return false;
}

function jsIdent(s: string): string {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s)) {
    if (s === "function" || s === "var" || s === "let") return `_${s}`;
    return s;
  }
  return `_${s.replace(/[^a-zA-Z0-9_$]/g, "_")}`;
}

export type Layout = {
  memory: Uint8Array;
  globalOff: Map<string, number>;
  stringOff: Map<Obj, number>;
  /** Byte offset where the runtime bump heap starts (after globals and string rodata). */
  heapBase: number;
};

type ScanfTarget =
  | { k: "local"; js: string }
  | { k: "mem"; ptr: string; size: number };

/** Size in bytes of the type `ptrNode` points to (default 4 if unknown). */
function pointeeSize(ptrNode: Node): number {
  const t = ptrNode.ty;
  if (t?.kind === TypeKind.Ptr && t.base) return t.base.size;
  return 4;
}

/**
 * Decides whether a `scanf` argument is a stack local (assign in JS) or linear-memory store.
 */
function classifyScanfPtr(
  ptrArg: Node,
  fn: Obj,
  localJs: Map<Obj, string>,
  layout: Layout,
  globalOffConst: Map<string, string>,
  definedFns: Set<string>
): ScanfTarget {
  if (ptrArg.kind === NodeKind.Addr && ptrArg.lhs?.kind === NodeKind.Var) {
    const v = ptrArg.lhs.var!;
    if (v.isLocal) {
      const js = localJs.get(v);
      if (js) return { k: "local", js };
    }
  }
  return {
    k: "mem",
    ptr: emitExpr(ptrArg, fn, localJs, layout, globalOffConst, definedFns),
    size: pointeeSize(ptrArg),
  };
}

/** Emits an IIFE that parses stdin via `__rt.scanfParsed` and assigns each target. */
function emitScanfCall(
  n: Node,
  fn: Obj,
  localJs: Map<Obj, string>,
  layout: Layout,
  globalOffConst: Map<string, string>,
  definedFns: Set<string>
): string {
  const fmtNode = n.args;
  if (!fmtNode) return "0n";
  const fmtJs = emitExpr(fmtNode, fn, localJs, layout, globalOffConst, definedFns);
  const targets: ScanfTarget[] = [];
  for (let a = fmtNode.next; a; a = a.next)
    targets.push(classifyScanfPtr(a, fn, localJs, layout, globalOffConst, definedFns));
  const assigns = targets
    .map((t, i) => {
      if (t.k === "local") return `${t.js} = _s[${i}] ?? 0n;`;
      return `__rt.store(${t.ptr}, _s[${i}] ?? 0n, ${t.size});`;
    })
    .join(" ");
  return `((() => { const _s = __rt.scanfParsed(${fmtJs}); ${assigns} return BigInt(_s.length); })())`;
}

/**
 * Lays out globals and string literals in a 1 MiB linear `memory` image; returns `heapBase` for malloc.
 */
export function layoutProgram(prog: Obj | null): Layout {
  const memory = new Uint8Array(1024 * 1024);
  let off = 0;
  const globalOff = new Map<string, number>();
  const stringOff = new Map<Obj, number>();

  for (let g = prog; g; g = g.next) {
    if (g.isFunction) continue;
    if (g.name.startsWith(".L.")) continue;
    off = alignTo(off, g.align);
    globalOff.set(g.name, off);
    if (g.initData) memory.set(g.initData, off);
    off += Math.max(g.ty.size, g.initData?.length ?? 0);
  }

  for (let g = prog; g; g = g.next) {
    if (!g.name.startsWith(".L.")) continue;
    if (!g.initData) continue;
    off = alignTo(off, g.align);
    stringOff.set(g, off);
    memory.set(g.initData, off);
    off += g.initData.length;
  }

  /* Never place the bump heap at offset 0: a successful malloc must not return 0n or C `p == NULL` checks fail. */
  const heapBase = Math.max(alignTo(off, 16), 16);
  return { memory, globalOff, stringOff, heapBase };
}

/**
 * Emits a JavaScript expression string evaluating the AST node (BigInt for integers, number for float literals).
 */
function emitExpr(
  n: Node | null,
  fn: Obj,
  localJs: Map<Obj, string>,
  layout: Layout,
  globalOffConst: Map<string, string>,
  definedFns: Set<string>
): string {
  if (!n) return "0n";
  addType(n);
  switch (n.kind) {
    case NodeKind.Num:
      if (n.ty && (n.ty.kind === TypeKind.Float || n.ty.kind === TypeKind.Double || n.ty.kind === TypeKind.LDouble))
        return String(n.fval);
      return `${n.val}n`;
    case NodeKind.Var: {
      const v = n.var!;
      if (v.isLocal) return localJs.get(v) ?? "0n";
      const go = globalOffConst.get(v.name);
      if (go) return `${go}`;
      const so = layout.stringOff.get(v);
      if (so !== undefined) return `${so}n`;
      return "0n";
    }
    case NodeKind.Cast:
      return `(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)})`;
    case NodeKind.Addr: {
      const inner = n.lhs;
      if (inner?.kind === NodeKind.Var) {
        const v = inner.var!;
        const go = globalOffConst.get(v.name);
        if (go) return `${go}n`;
        const so = layout.stringOff.get(v);
        if (so !== undefined) return `${so}n`;
      }
      return `BigInt(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)})`;
    }
    case NodeKind.Deref:
      return `__rt.load(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)}, ${n.ty!.size})`;
    case NodeKind.Add: {
      const L = emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns);
      const R = emitExpr(n.rhs, fn, localJs, layout, globalOffConst, definedFns);
      const lp = peelPtrExpr(n.lhs);
      const rp = peelPtrExpr(n.rhs);
      if (lp && effectiveIntegerExpr(n.rhs) && !rp) {
        const sz = lp.ty!.base!.size;
        const off = sz === 1 ? R : `(${R} * ${BigInt(sz)}n)`;
        return `__rt.ptrAdd(${L}, ${off})`;
      }
      if (rp && effectiveIntegerExpr(n.lhs) && !lp) {
        const sz = rp.ty!.base!.size;
        const off = sz === 1 ? L : `(${L} * ${BigInt(sz)}n)`;
        return `__rt.ptrAdd(${R}, ${off})`;
      }
      if (n.ty?.kind === TypeKind.Ptr || n.lhs?.ty?.kind === TypeKind.Ptr)
        return `__rt.ptrAdd(${L}, ${R})`;
      return `(${L} + ${R})`;
    }
    case NodeKind.Sub: {
      const L = emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns);
      const R = emitExpr(n.rhs, fn, localJs, layout, globalOffConst, definedFns);
      const lp = peelPtrExpr(n.lhs);
      const rp = peelPtrExpr(n.rhs);
      if (lp && effectiveIntegerExpr(n.rhs) && !rp) {
        const sz = lp.ty!.base!.size;
        const off = sz === 1 ? R : `(${R} * ${BigInt(sz)}n)`;
        return `__rt.ptrSub(${L}, ${off})`;
      }
      if (n.lhs?.ty?.kind === TypeKind.Ptr) return `__rt.ptrSub(${L}, ${R})`;
      return `(${L} - ${R})`;
    }
    case NodeKind.Mul:
      return `(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)} * ${emitExpr(n.rhs, fn, localJs, layout, globalOffConst, definedFns)})`;
    case NodeKind.Div:
      return `(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)} / ${emitExpr(n.rhs, fn, localJs, layout, globalOffConst, definedFns)})`;
    case NodeKind.Mod:
      return `(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)} % ${emitExpr(n.rhs, fn, localJs, layout, globalOffConst, definedFns)})`;
    case NodeKind.Eq:
      return `__rt.eq(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)}, ${emitExpr(n.rhs, fn, localJs, layout, globalOffConst, definedFns)})`;
    case NodeKind.Ne:
      return `!__rt.eq(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)}, ${emitExpr(n.rhs, fn, localJs, layout, globalOffConst, definedFns)})`;
    case NodeKind.Lt:
      return `(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)} < ${emitExpr(n.rhs, fn, localJs, layout, globalOffConst, definedFns)})`;
    case NodeKind.Le:
      return `(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)} <= ${emitExpr(n.rhs, fn, localJs, layout, globalOffConst, definedFns)})`;
    case NodeKind.Assign: {
      const lhs = n.lhs!;
      if (lhs.kind === NodeKind.Var && lhs.var!.isLocal) {
        const nm = localJs.get(lhs.var!)!;
        return `(${nm} = ${emitExpr(n.rhs, fn, localJs, layout, globalOffConst, definedFns)})`;
      }
      if (lhs.kind === NodeKind.Deref) {
        return `__rt.store(${emitExpr(lhs.lhs, fn, localJs, layout, globalOffConst, definedFns)}, ${emitExpr(
          n.rhs,
          fn,
          localJs,
          layout,
          globalOffConst,
          definedFns
        )}, ${lhs.ty!.size})`;
      }
      if (lhs.kind === NodeKind.Member) {
        const md = memberDerefBase(lhs, (x) => emitExpr(x, fn, localJs, layout, globalOffConst, definedFns));
        if (md)
          return `__rt.store(__rt.ptrAdd(${md.ptr}, ${md.offset}n), ${emitExpr(
            n.rhs,
            fn,
            localJs,
            layout,
            globalOffConst,
            definedFns
          )}, ${lhs.member!.ty.size})`;
      }
      if (lhs.kind === NodeKind.Var) {
        const g = globalOffConst.get(lhs.var!.name);
        if (g)
          return `__rt.storeGlobal(${g}, ${emitExpr(n.rhs, fn, localJs, layout, globalOffConst, definedFns)}, ${lhs.ty!.size})`;
      }
      return `0n`;
    }
    case NodeKind.Funcall: {
      const callee = n.lhs!;
      let name = "";
      if (callee.kind === NodeKind.Var) name = callee.var!.name;
      const args: string[] = [];
      for (let a = n.args; a; a = a.next) args.push(emitExpr(a, fn, localJs, layout, globalOffConst, definedFns));
      if (name === "printf") return `__rt.printf(${args.join(", ")})`;
      if (name === "sprintf") return `__rt.sprintf(${args.join(", ")})`;
      if (name === "scanf") return emitScanfCall(n, fn, localJs, layout, globalOffConst, definedFns);
      if (name === "malloc") return `__rt.malloc(${args.join(", ")})`;
      if (name === "free") return `__rt.free(${args.join(", ")})`;
      if (name === "srand") return `__rt.srand(${args.join(", ")})`;
      if (name === "rand") return `__rt.rand()`;
      if (name === "time") return `__rt.time(${args.join(", ")})`;
      if (name === "sleep") return `__rt.sleep(${args.join(", ")})`;
      if (name === "fopen") return `__rt.fopen(${args.join(", ")})`;
      if (name === "fclose") return `__rt.fclose(${args.join(", ")})`;
      if (name === "fread") return `__rt.fread(${args.join(", ")})`;
      if (name === "fwrite") return `__rt.fwrite(${args.join(", ")})`;
      if (name === "fseek") return `__rt.fseek(${args.join(", ")})`;
      if (name === "ftell") return `__rt.ftell(${args.join(", ")})`;
      if (name === "fflush") return `__rt.fflush(${args.join(", ")})`;
      if (definedFns.has(name)) return `${jsIdent("fn_" + name)}(${args.join(", ")})`;
      return `__rt.call(${JSON.stringify(name)}, [${args.join(", ")}])`;
    }
    case NodeKind.Member: {
      const md = memberDerefBase(n, (x) => emitExpr(x, fn, localJs, layout, globalOffConst, definedFns));
      if (md) return `__rt.member(${md.ptr}, ${md.offset}, ${n.member!.ty.size})`;
      return `__rt.member(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)}, ${n.member!.offset}, ${n.member!.ty.size})`;
    }
    case NodeKind.Not:
      return `!__rt.truthy(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)})`;
    case NodeKind.LogAnd:
      return `(__rt.truthy(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)}) && __rt.truthy(${emitExpr(
        n.rhs,
        fn,
        localJs,
        layout,
        globalOffConst,
        definedFns
      )}))`;
    case NodeKind.LogOr:
      return `(__rt.truthy(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)}) || __rt.truthy(${emitExpr(
        n.rhs,
        fn,
        localJs,
        layout,
        globalOffConst,
        definedFns
      )}))`;
    case NodeKind.Comma:
      return `(${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)}, ${emitExpr(n.rhs, fn, localJs, layout, globalOffConst, definedFns)})`;
    case NodeKind.Neg:
      return `(-${emitExpr(n.lhs, fn, localJs, layout, globalOffConst, definedFns)})`;
    default:
      return "0n";
  }
}

/**
 * C `for`/`while` conditions that already lower to a JavaScript boolean.
 * Wrapping those in `__rt.truthy` adds a host call per iteration with no semantic benefit.
 */
function loopCondSkipsTruthy(n: Node | null): boolean {
  if (!n) return true;
  switch (n.kind) {
    case NodeKind.Lt:
    case NodeKind.Le:
    case NodeKind.Eq:
    case NodeKind.Ne:
    case NodeKind.LogAnd:
    case NodeKind.LogOr:
    case NodeKind.Not:
      return true;
    default:
      return false;
  }
}

function emitLoopCond(
  n: Node | null,
  fn: Obj,
  localJs: Map<Obj, string>,
  layout: Layout,
  globalOffConst: Map<string, string>,
  definedFns: Set<string>
): string {
  if (!n) return "true";
  const ex = emitExpr(n, fn, localJs, layout, globalOffConst, definedFns);
  if (loopCondSkipsTruthy(n)) return ex;
  return `__rt.truthy(${ex})`;
}

let switchTempId = 0;
/** Maps C `brkLabel` on a Switch to the JS label on that `switch`; used so `break` exits the switch, never an outer loop. */
const switchBreakTargets: { brk: string; lab: string }[] = [];

/**
 * Emits JavaScript statements for a statement list; `chain` follows `next` for sequential stmts.
 */
function emitStmt(
  cur: Node | null,
  fn: Obj,
  localJs: Map<Obj, string>,
  layout: Layout,
  globalOffConst: Map<string, string>,
  definedFns: Set<string>,
  indent: string,
  chain: boolean = true
): string {
  if (!cur) return "";
  let s = "";
  switch (cur.kind) {
    case NodeKind.Block: {
      for (let b = cur.body; b; b = b.next)
        s += emitStmt(b, fn, localJs, layout, globalOffConst, definedFns, indent, false);
      break;
    }
    case NodeKind.Return:
      s += `${indent}return ${cur.lhs ? emitExpr(cur.lhs, fn, localJs, layout, globalOffConst, definedFns) : "0n"};\n`;
      break;
    case NodeKind.ExprStmt:
      s += `${indent}${emitExpr(cur.lhs, fn, localJs, layout, globalOffConst, definedFns)};\n`;
      break;
    case NodeKind.If: {
      s += `${indent}if (__rt.truthy(${emitExpr(cur.cond, fn, localJs, layout, globalOffConst, definedFns)})) {\n`;
      s += emitStmt(cur.then, fn, localJs, layout, globalOffConst, definedFns, indent + "  ", false);
      s += `${indent}}`;
      if (cur.els) {
        s += ` else {\n`;
        s += emitStmt(cur.els, fn, localJs, layout, globalOffConst, definedFns, indent + "  ", false);
        s += `${indent}}\n`;
      } else s += "\n";
      break;
    }
    case NodeKind.For: {
      const isWhile = !cur.init && !cur.inc;
      if (isWhile) {
        const condEx = emitLoopCond(cur.cond, fn, localJs, layout, globalOffConst, definedFns);
        s += `${indent}while (${condEx}) {\n`;
        s += emitStmt(cur.then, fn, localJs, layout, globalOffConst, definedFns, indent + "  ", false);
        s += `${indent}}\n`;
      } else {
        const initS = cur.init
          ? emitStmt(cur.init, fn, localJs, layout, globalOffConst, definedFns, "", true)
              .replace(/\n+/g, " ")
              .trim()
              .replace(/;\s*$/, "")
          : "";
        const condEx = emitLoopCond(cur.cond, fn, localJs, layout, globalOffConst, definedFns);
        const incEx = cur.inc ? emitExpr(cur.inc, fn, localJs, layout, globalOffConst, definedFns) : "";
        s += `${indent}for (${initS}; ${condEx}; ${incEx}) {\n`;
        s += emitStmt(cur.then, fn, localJs, layout, globalOffConst, definedFns, indent + "  ", false);
        s += `${indent}}\n`;
      }
      break;
    }
    case NodeKind.Break: {
      let lab: string | null = null;
      const bl = cur.brkLabel;
      if (bl) {
        for (let i = switchBreakTargets.length - 1; i >= 0; i--) {
          if (switchBreakTargets[i]!.brk === bl) {
            lab = switchBreakTargets[i]!.lab;
            break;
          }
        }
      }
      s += lab ? `${indent}break ${lab};\n` : `${indent}break;\n`;
      break;
    }
    case NodeKind.Continue:
      s += `${indent}continue;\n`;
      break;
    case NodeKind.Switch: {
      const blk = cur.body!;
      const sid = switchTempId++;
      const v = `_sw${sid}`;
      const swLab = `__sw${sid}`;
      const ind2 = indent + "  ";
      const brk = cur.brkLabel;
      if (brk) switchBreakTargets.push({ brk, lab: swLab });
      try {
        s += `${indent}{\n`;
        let n: Node | null = blk.body;
        while (n && n.kind !== NodeKind.Case) {
          s += emitStmt(n, fn, localJs, layout, globalOffConst, definedFns, ind2, false);
          n = n.next;
        }
        const disc = emitExpr(cur.cond, fn, localJs, layout, globalOffConst, definedFns);
        s += `${ind2}const ${v} = (${disc});\n`;
        s += `${ind2}${swLab}: switch (true) {\n`;
        for (; n && n.kind === NodeKind.Case; n = n.next) {
          s += `${ind2}  case __rt.eq(${v}, ${n.begin}n):\n`;
          for (let st = n.body; st; st = st.next)
            s += emitStmt(st, fn, localJs, layout, globalOffConst, definedFns, ind2 + "    ", false);
        }
        if (cur.defaultCase) {
          s += `${ind2}  default:\n`;
          let dst: Node | null = cur.defaultCase;
          while (dst) {
            s += emitStmt(dst, fn, localJs, layout, globalOffConst, definedFns, ind2 + "    ", false);
            dst = dst.next;
          }
        }
        s += `${ind2}}\n`;
        s += `${indent}}\n`;
      } finally {
        if (brk) switchBreakTargets.pop();
      }
      break;
    }
    default:
      s += `${indent}/* ${cur.kind} */\n`;
  }
  if (chain && cur.next) s += emitStmt(cur.next, fn, localJs, layout, globalOffConst, definedFns, indent, true);
  return s;
}

/**
 * Lowers the whole program: every defined function becomes `fn_<name>(a0,…)` plus `return { … }` export object.
 */
export function codegen(prog: Obj | null): { source: string; layout: Layout } {
  for (let g = prog; g; g = g.next) if (g.isFunction) addTypesFn(g);

  const definedFns = new Set<string>();
  for (let g = prog; g; g = g.next) {
    if (g.isFunction && g.body) definedFns.add(g.name);
  }

  const layout = layoutProgram(prog);
  const globalOffConst = new Map<string, string>();
  for (const [name, off] of layout.globalOff) {
    if (!name.startsWith(".L.")) globalOffConst.set(name, String(off));
  }

  const lines: string[] = [];
  lines.push(`(function(__rt) {`);

  for (let g = prog; g; g = g.next) {
    if (!g.isFunction || !g.body) continue;
    const fn = g;
    const localJs = new Map<Obj, string>();
    let li = 0;
    for (let l = fn.locals; l; l = l.next) localJs.set(l, `l${li++}`);

    const ordered = paramsInOrder(fn);
    const argList = ordered.map((_, i) => `a${i}`).join(", ");
    lines.push(`function ${jsIdent("fn_" + fn.name)}(${argList}) {`);

    for (let l = fn.locals; l; l = l.next) {
      const j = localJs.get(l)!;
      if (l.ty.kind === TypeKind.Array && l.ty.base === tyChar) lines.push(`let ${j} = 0n;`);
      else lines.push(`let ${j} = 0n;`);
    }
    for (let i = 0; i < ordered.length; i++) {
      const l = ordered[i]!;
      lines.push(`${localJs.get(l)!} = BigInt(a${i});`);
    }

    switchBreakTargets.length = 0;
    const body = emitStmt(fn.body, fn, localJs, layout, globalOffConst, definedFns, "  ");
    lines.push(body);
    lines.push(`}`);
  }

  lines.push(`return {`);
  for (let g = prog; g; g = g.next) {
    if (g.isFunction && g.body) lines.push(`  ${JSON.stringify("fn_" + g.name)}: ${jsIdent("fn_" + g.name)},`);
  }
  lines.push(`};`);
  lines.push(`})`);

  return { source: lines.join("\n"), layout };
}
