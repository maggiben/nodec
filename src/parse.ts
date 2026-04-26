/**
 * Recursive-descent parser.
 * Covers a large C11 subset suitable for real small programs.
 */

import {
  type Node,
  type Obj,
  type Type,
  type Member,
  type Token,
  NodeKind,
  TypeKind,
  tyVoid,
  tyBool,
  tyChar,
  tyShort,
  tyInt,
  tyLong,
  tyFloat,
  tyDouble,
  tyLdouble,
  tyUchar,
  tyUshort,
  tyUint,
  tyUlong,
  copyType,
  pointerTo,
  funcType,
  arrayOf,
  enumType,
  structType,
  unionType,
} from "./ctypes.js";
import { equal, skip } from "./tokenize.js";
import { TokenKind } from "./ctypes.js";
import { errorTok } from "./diag.js";
import { addType, newCast, isInteger } from "./typeops.js";

type VarScope = {
  var: Obj | null;
  typeDef: Type | null;
  enumTy: Type | null;
  enumVal: number;
};

type Scope = {
  next: Scope | null;
  vars: Map<string, VarScope>;
  tags: Map<string, Type>;
};

type VarAttr = {
  isTypedef: boolean;
  isStatic: boolean;
  isExtern: boolean;
  isInline: boolean;
  isTls: boolean;
  align: number;
};

/** Rounds `n` up to the next multiple of `align` (struct member layout). */
function alignTo(n: number, align: number): number {
  return Math.floor((n + align - 1) / align) * align;
}

/** Lexeme of an identifier token; errors if `tok` is not {@link TokenKind.Ident}. */
function getIdent(tok: Token): string {
  if (tok.kind !== TokenKind.Ident) errorTok(tok, "expected an identifier");
  return tok.file.contents.slice(tok.loc, tok.loc + tok.len);
}

/** Allocates a zeroed {@link Node} shell of the given kind. */
function newNode(kind: NodeKind, tok: Token | null): Node {
  return {
    kind,
    next: null,
    ty: null,
    tok,
    lhs: null,
    rhs: null,
    cond: null,
    then: null,
    els: null,
    init: null,
    inc: null,
    brkLabel: null,
    contLabel: null,
    body: null,
    member: null,
    funcTy: null,
    args: null,
    passByStack: false,
    retBuffer: null,
    label: null,
    uniqueLabel: null,
    gotoNext: null,
    caseNext: null,
    defaultCase: null,
    begin: 0n,
    end: 0n,
    asmStr: null,
    casAddr: null,
    casOld: null,
    casNew: null,
    atomicAddr: null,
    atomicExpr: null,
    var: null,
    val: 0n,
    fval: 0,
  };
}

/** Integer literal AST node. */
function newNum(val: bigint, tok: Token | null): Node {
  const n = newNode(NodeKind.Num, tok);
  n.val = val;
  return n;
}

/** Binary operator or assignment node. */
function newBinary(kind: NodeKind, lhs: Node, rhs: Node, tok: Token | null): Node {
  const n = newNode(kind, tok);
  n.lhs = lhs;
  n.rhs = rhs;
  return n;
}

/** Unary operator node (`lhs` holds the operand). */
function newUnary(kind: NodeKind, expr: Node, tok: Token | null): Node {
  const n = newNode(kind, tok);
  n.lhs = expr;
  return n;
}

let locals: Obj | null = null;
let globals: Obj | null = null;
let scope: Scope = { next: null, vars: new Map(), tags: new Map() };
let currentFn: Obj | null = null;
let brkLabel: string | null = null;
let contLabel: string | null = null;
let labelId = 0;

/** Pushes an inner lexical scope for locals, typedefs, and tags. */
function enterScope(): void {
  scope = { next: scope, vars: new Map(), tags: new Map() };
}

/** Pops the innermost scope (must not pop the translation-unit root). */
function leaveScope(): void {
  if (!scope.next) errorTok(null as unknown as Token, "internal scope error");
  scope = scope.next!;
}

/** Looks up `name` for variable, typedef, or enumerator binding. */
function findVar(name: string): VarScope | null {
  for (let sc: Scope | null = scope; sc; sc = sc.next) {
    const v = sc.vars.get(name);
    if (v) return v;
  }
  return null;
}

/** Looks up struct/union/enum tag `name` in the scope chain. */
function findTag(name: string): Type | null {
  for (let sc: Scope | null = scope; sc; sc = sc.next) {
    const t = sc.tags.get(name);
    if (t) return t;
  }
  return null;
}

/** Inserts a fresh {@link VarScope} entry for `name` in the current scope. */
function pushScopeVar(name: string): VarScope {
  const vs: VarScope = { var: null, typeDef: null, enumTy: null, enumVal: 0 };
  scope.vars.set(name, vs);
  return vs;
}

/** Binds aggregate tag `name` to incomplete or complete type `ty`. */
function pushTag(name: string, ty: Type): void {
  scope.tags.set(name, ty);
}

/** Declares a symbol in the current scope table (not yet linked as local/global). */
function newVar(name: string, ty: Type, tok: Token | null): Obj {
  const vs = pushScopeVar(name);
  const v: Obj = {
    next: null,
    name,
    ty,
    tok,
    isLocal: false,
    align: ty.align,
    offset: 0,
    isFunction: false,
    isDefinition: false,
    isStatic: false,
    isTentative: false,
    isTls: false,
    initData: null,
    rel: null,
    isInline: false,
    params: null,
    body: null,
    locals: null,
    vaArea: null,
    allocaBottom: null,
    stackSize: 0,
    isLive: false,
    isRoot: false,
    refs: [],
  };
  vs.var = v;
  return v;
}

/** Stack-local variable for the current function (`locals` list head). */
function newLvar(name: string, ty: Type, tok: Token | null): Obj {
  const v = newVar(name, ty, tok);
  v.isLocal = true;
  v.next = locals;
  locals = v;
  return v;
}

/** File-scope object (function, global, or static); prepended to `globals`. */
function newGvar(name: string, ty: Type): Obj {
  const vs = pushScopeVar(name);
  const v: Obj = {
    next: globals,
    name,
    ty,
    tok: null,
    isLocal: false,
    align: ty.align,
    offset: 0,
    isFunction: false,
    isDefinition: true,
    isStatic: true,
    isTentative: false,
    isTls: false,
    initData: null,
    rel: null,
    isInline: false,
    params: null,
    body: null,
    locals: null,
    vaArea: null,
    allocaBottom: null,
    stackSize: 0,
    isLive: false,
    isRoot: false,
    refs: [],
  };
  vs.var = v;
  globals = v;
  return v;
}

/** Fresh internal name for string literals, anon symbols, and break labels. */
function newUniqueName(): string {
  return `.L.${labelId++}`;
}

/** Anonymous global with internal `.L.*` name. */
function newAnonGvar(ty: Type): Obj {
  return newGvar(newUniqueName(), ty);
}

/** Read-only global holding string literal bytes plus trailing zero. */
function newStringLiteral(bytes: Uint8Array, ty: Type): Obj {
  const v = newAnonGvar(ty);
  const buf = new Uint8Array(bytes.length + 1);
  buf.set(bytes);
  v.initData = buf;
  return v;
}

/** Expression node that loads object `v`. */
function newVarNode(v: Obj, tok: Token | null): Node {
  const n = newNode(NodeKind.Var, tok);
  n.var = v;
  return n;
}

/**
 * Parses one translation unit from preprocessor output into a linked list of {@link Obj} globals/functions.
 * @param tok First token; advances through {@link TokenKind.Eof}.
 * @returns Head of `globals`, or `null` if the file was empty of declarations.
 */
export function parse(tok: Token | null): Obj | null {
  locals = null;
  globals = null;
  scope = { next: null, vars: new Map(), tags: new Map() };
  currentFn = null;
  const ctx: { t: Token | null } = { t: tok };
  while (ctx.t && ctx.t.kind !== TokenKind.Eof) {
    const attr: VarAttr = {
      isTypedef: false,
      isStatic: false,
      isExtern: false,
      isInline: false,
      isTls: false,
      align: 0,
    };
    const basety = declspec(ctx, ctx.t, attr);
    if (attr.isTypedef) {
      parseTypedef(ctx, ctx.t!, basety);
      continue;
    }
    if (isFunction(ctx.t!)) {
      parseFunction(ctx, ctx.t!, basety, attr);
      continue;
    }
    globalVariable(ctx, ctx.t!, basety, attr);
  }
  scanGlobals();
  return globals;
}

/** Drops tentative definitions superseded by a real definition; compacts the `globals` list. */
function scanGlobals(): void {
  const seen = new Map<string, Obj>();
  let cur: Obj | null = null;
  let head: Obj | null = null;
  for (let v = globals; v; v = v.next) {
    if (!v.isTentative) {
      if (!head) head = v;
      else cur!.next = v;
      cur = v;
      seen.set(v.name, v);
      continue;
    }
    let other: Obj | null = globals;
    let found = false;
    while (other) {
      if (other !== v && other.isDefinition && other.name === v.name) {
        found = true;
        break;
      }
      other = other.next;
    }
    if (!found) {
      if (!head) head = v;
      else cur!.next = v;
      cur = v;
    }
  }
  if (cur) cur.next = null;
  globals = head;
}

/** True if `tok` can start a declaration-specifier (type name or typedef). */
function isTypename(tok: Token | null): boolean {
  if (!tok) return false;
  if (tok.kind === TokenKind.Keyword) {
    const k = tok.file.contents.slice(tok.loc, tok.loc + tok.len);
    return (
      k === "void" ||
      k === "_Bool" ||
      k === "char" ||
      k === "short" ||
      k === "int" ||
      k === "long" ||
      k === "struct" ||
      k === "union" ||
      k === "enum" ||
      k === "signed" ||
      k === "unsigned" ||
      k === "typeof" ||
      k === "const" ||
      k === "volatile" ||
      k === "auto" ||
      k === "register" ||
      k === "restrict" ||
      k === "__restrict" ||
      k === "__restrict__" ||
      k === "_Noreturn" ||
      k === "float" ||
      k === "double" ||
      k === "_Atomic" ||
      k === "_Alignas"
    );
  }
  if (tok.kind === TokenKind.Ident) {
    const sc = findVar(getIdent(tok));
    return !!(sc && sc.typeDef);
  }
  return false;
}

/**
 * Parses declaration specifiers (storage class, type, qualifiers); updates `ctx.t` past consumed tokens.
 * @param attr Receives typedef/static/extern/etc.; may be null in type-only contexts.
 */
function declspec(ctx: { t: Token | null }, tok: Token, attr: VarAttr | null): Type {
  enum C {
    VOID = 1 << 0,
    BOOL = 1 << 2,
    CHAR = 1 << 4,
    SHORT = 1 << 6,
    INT = 1 << 8,
    LONG = 1 << 10,
    FLOAT = 1 << 12,
    DOUBLE = 1 << 14,
    OTHER = 1 << 16,
    SIGNED = 1 << 17,
    UNSIGNED = 1 << 18,
  }
  let ty: Type = tyInt;
  let counter = 0;
  let isAtomic = false;
  let t: Token | null = tok;

  while (t && isTypename(t)) {
    const kw = t.file.contents.slice(t.loc, t.loc + t.len);
    if (
      kw === "typedef" ||
      kw === "static" ||
      kw === "extern" ||
      kw === "inline" ||
      kw === "_Thread_local" ||
      kw === "__thread"
    ) {
      if (!attr) errorTok(t, "storage class specifier is not allowed in this context");
      if (kw === "typedef") attr.isTypedef = true;
      else if (kw === "static") attr.isStatic = true;
      else if (kw === "extern") attr.isExtern = true;
      else if (kw === "inline") attr.isInline = true;
      else attr.isTls = true;
      t = t.next;
      continue;
    }
    if (
      kw === "const" ||
      kw === "volatile" ||
      kw === "auto" ||
      kw === "register" ||
      kw === "restrict" ||
      kw === "__restrict" ||
      kw === "__restrict__" ||
      kw === "_Noreturn"
    ) {
      t = t.next;
      continue;
    }
    if (kw === "_Atomic") {
      t = t.next!;
      if (equal(t, "(")) {
        typename(ctx, t.next!);
        t = skip(ctx.t!, ")");
      }
      isAtomic = true;
      continue;
    }
    if (kw === "_Alignas") {
      if (!attr) errorTok(t, "_Alignas is not allowed in this context");
      t = skip(t.next!, "(");
      if (isTypename(t)) {
        const tty = typename(ctx, t);
        attr.align = tty.align;
        t = ctx.t;
      } else {
        const _e = constExpr(ctx, t);
        attr.align = Number(_e);
        t = ctx.t;
      }
      t = skip(t!, ")");
      continue;
    }
    const ty2 = t.kind === TokenKind.Ident ? findVar(getIdent(t))?.typeDef ?? null : null;
    if (kw === "struct" || kw === "union" || kw === "enum" || kw === "typeof" || ty2) {
      if (counter) break;
      if (kw === "struct") ty = structDecl(ctx, t.next!);
      else if (kw === "union") ty = unionDecl(ctx, t.next!);
      else if (kw === "enum") ty = enumSpecifier(ctx, t.next!);
      else if (kw === "typeof") ty = typeofSpecifier(ctx, t.next!);
      else {
        ty = ty2!;
        t = t.next!;
      }
      t = ctx.t;
      counter += C.OTHER;
      continue;
    }
    if (kw === "void") counter += C.VOID;
    else if (kw === "_Bool") counter += C.BOOL;
    else if (kw === "char") counter += C.CHAR;
    else if (kw === "short") counter += C.SHORT;
    else if (kw === "int") counter += C.INT;
    else if (kw === "long") counter += C.LONG;
    else if (kw === "float") counter += C.FLOAT;
    else if (kw === "double") counter += C.DOUBLE;
    else if (kw === "signed") counter |= C.SIGNED;
    else if (kw === "unsigned") counter |= C.UNSIGNED;
    else errorTok(t, "internal declspec");
    switch (counter) {
      case C.VOID:
        ty = tyVoid;
        break;
      case C.BOOL:
        ty = tyBool;
        break;
      case C.CHAR:
      case C.SIGNED + C.CHAR:
        ty = tyChar;
        break;
      case C.UNSIGNED + C.CHAR:
        ty = tyUchar;
        break;
      case C.SHORT:
      case C.SHORT + C.INT:
      case C.SIGNED + C.SHORT:
      case C.SIGNED + C.SHORT + C.INT:
        ty = tyShort;
        break;
      case C.UNSIGNED + C.SHORT:
      case C.UNSIGNED + C.SHORT + C.INT:
        ty = tyUshort;
        break;
      case C.INT:
      case C.SIGNED:
      case C.SIGNED + C.INT:
        ty = tyInt;
        break;
      case C.UNSIGNED:
      case C.UNSIGNED + C.INT:
        ty = tyUint;
        break;
      case C.LONG:
      case C.LONG + C.INT:
      case C.LONG + C.LONG:
      case C.LONG + C.LONG + C.INT:
      case C.SIGNED + C.LONG:
      case C.SIGNED + C.LONG + C.INT:
      case C.SIGNED + C.LONG + C.LONG:
      case C.SIGNED + C.LONG + C.LONG + C.INT:
        ty = tyLong;
        break;
      case C.UNSIGNED + C.LONG:
      case C.UNSIGNED + C.LONG + C.INT:
      case C.UNSIGNED + C.LONG + C.LONG:
      case C.UNSIGNED + C.LONG + C.LONG + C.INT:
        ty = tyUlong;
        break;
      case C.FLOAT:
        ty = tyFloat;
        break;
      case C.DOUBLE:
        ty = tyDouble;
        break;
      case C.LONG + C.DOUBLE:
        ty = tyLdouble;
        break;
      default:
        errorTok(t, "invalid type");
    }
    t = t.next;
  }
  if (isAtomic) {
    ty = copyType(ty);
    ty.isAtomic = true;
  }
  ctx.t = t;
  return ty;
}

/** `typeof` on a type name or unary expression; yields the operand's type. */
function typeofSpecifier(ctx: { t: Token | null }, tok: Token): Type {
  if (equal(tok, "(") && isTypename(tok.next)) {
    const ty = typename(ctx, tok.next!);
    ctx.t = skip(ctx.t!, ")");
    return ty;
  }
  const node = unary(ctx, tok);
  addType(node);
  ctx.t = ctx.t;
  return node.ty!;
}

/** Parses `enum` with optional tag and enumerator list; registers constants in scope. */
function enumSpecifier(ctx: { t: Token | null }, tok: Token): Type {
  const ty = enumType();
  let tag: string | null = null;
  let t = tok;
  if (t.kind === TokenKind.Ident) {
    tag = getIdent(t);
    t = t.next!;
  }
  if (tag && !equal(t, "{")) {
    const ty2 = findTag(tag);
    if (ty2) {
      ctx.t = t;
      return ty2;
    }
    ty.tag = tag;
    pushTag(tag, ty);
    ctx.t = t;
    return ty;
  }
  t = skip(t, "{");
  let val = 0;
  let first = true;
  while (!equal(t, "}")) {
    if (!first) t = skip(t, ",");
    first = false;
    const nameTok = t;
    const nm = getIdent(nameTok);
    t = nameTok.next!;
    if (equal(t, "=")) {
      val = Number(constExpr(ctx, t.next!));
      t = ctx.t!;
    }
    const vs = pushScopeVar(nm);
    vs.enumTy = ty;
    vs.enumVal = val;
    val++;
  }
  t = skip(t, "}");
  if (tag) pushTag(tag, ty);
  ctx.t = t;
  return ty;
}

/** Shared parser for `struct` or `union` definitions and forward declarations. */
function structUnionDecl(ctx: { t: Token | null }, tok: Token, kind: TypeKind.Struct | TypeKind.Union): Type {
  const ty = kind === TypeKind.Struct ? structType() : unionType();
  ty.kind = kind;
  let t = tok;
  let tag: string | null = null;
  if (t.kind === TokenKind.Ident) {
    tag = getIdent(t);
    t = t.next!;
  }
  if (tag && !equal(t, "{")) {
    const ty2 = findTag(tag);
    if (ty2) {
      ctx.t = t;
      return ty2;
    }
    ty.tag = tag;
    ty.size = -1;
    ty.isComplete = false;
    pushTag(tag, ty);
    ctx.t = t;
    return ty;
  }
  t = skip(t, "{");
  let head: Member | null = null;
  let cur: Member | null = null;
  let idx = 0;
  while (!equal(t, "}")) {
    const a: VarAttr = {
      isTypedef: false,
      isStatic: false,
      isExtern: false,
      isInline: false,
      isTls: false,
      align: 0,
    };
    const memCtx: { t: Token | null } = { t };
    const basety = declspec(memCtx, t, a);
    t = memCtx.t!;
    let memFirst = true;
    memCtx.t = t;
    for (;;) {
      if (memCtx.t && equal(memCtx.t, ";")) {
        memCtx.t = memCtx.t.next;
        break;
      }
      if (!memFirst) memCtx.t = skip(memCtx.t!, ",");
      memFirst = false;
      const mty = declarator(memCtx, memCtx.t!, basety);
      const mem: Member = {
        next: null,
        ty: mty,
        tok: mty.name,
        name: mty.name ? getIdent(mty.name) : null,
        idx: idx++,
        align: a.align || mty.align,
        offset: 0,
        isBitfield: false,
        bitOffset: 0,
        bitWidth: 0,
      };
      if (!head) head = mem;
      else cur!.next = mem;
      cur = mem;
    }
    t = memCtx.t!;
  }
  t = skip(t, "}");
  ty.members = head;
  if (kind === TypeKind.Struct) {
    let off = 0;
    for (let m = head; m; m = m.next) {
      off = alignTo(off, m.align);
      m.offset = off;
      off += m.ty.size;
      if (ty.align < m.align) ty.align = m.align;
    }
    ty.size = alignTo(off, ty.align);
  } else {
    let max = 0;
    for (let m = head; m; m = m.next) {
      m.offset = 0;
      if (m.ty.size > max) max = m.ty.size;
      if (ty.align < m.align) ty.align = m.align;
    }
    ty.size = alignTo(max, ty.align);
  }
  ty.isComplete = true;
  if (tag) {
    const ty2 = findTag(tag);
    if (ty2 && ty2.members) {
      Object.assign(ty2, ty);
      ctx.t = t;
      return ty2;
    }
    pushTag(tag, ty);
  }
  ctx.t = t;
  return ty;
}

/** Parses a `struct` type. */
function structDecl(ctx: { t: Token | null }, tok: Token): Type {
  return structUnionDecl(ctx, tok, TypeKind.Struct);
}

/** Parses a `union` type. */
function unionDecl(ctx: { t: Token | null }, tok: Token): Type {
  return structUnionDecl(ctx, tok, TypeKind.Union);
}

/** Type name in contexts like `sizeof(int)` or casts: specifiers plus abstract declarator. */
function typename(ctx: { t: Token | null }, tok: Token): Type {
  const ty = declspec(ctx, tok, null);
  return abstractDeclarator(ctx, ctx.t!, ty);
}

/** Parses `(void)` or `(T1, T2, ...)` parameter list and builds a {@link TypeKind.Func} type. */
function funcParams(ctx: { t: Token | null }, tok: Token, ret: Type): Type {
  let t = tok;
  if (equal(t, "void") && equal(t.next!, ")")) {
    ctx.t = t.next!.next;
    return funcType(ret);
  }
  const head: Type = { ...funcType(tyVoid), params: null } as Type;
  let cur: Type | null = null;
  let isVariadic = false;
  const dummyHead = head;
  while (!equal(t, ")")) {
    if (cur !== null) t = skip(t, ",");
    if (equal(t, "...")) {
      isVariadic = true;
      t = t.next!;
      skip(t, ")");
      break;
    }
    const paramCtx = { t };
    const ty = declspec(paramCtx, t, null);
    const pty = declarator(paramCtx, paramCtx.t!, ty);
    t = paramCtx.t!;
    let ft = pty;
    if (pty.kind === TypeKind.Array) {
      ft = pointerTo(pty.base!);
      ft.name = pty.name;
      ft.namePos = pty.namePos;
    } else if (pty.kind === TypeKind.Func) {
      ft = pointerTo(pty);
      ft.name = pty.name;
      ft.namePos = pty.namePos;
    }
    const c = copyType(ft);
    if (!dummyHead.params) dummyHead.params = c;
    else cur!.next = c;
    cur = c;
  }
  if (!dummyHead.params) isVariadic = true;
  const fn = funcType(ret);
  fn.params = dummyHead.params;
  fn.isVariadic = isVariadic;
  ctx.t = t.next;
  return fn;
}

/** Array declarator `[n]` or `[]` with optional static/restrict noise. */
function arrayDimensions(ctx: { t: Token | null }, tok: Token, base: Type): Type {
  let t = tok;
  while (equal(t, "static") || equal(t, "restrict")) t = t.next!;
  if (equal(t, "]")) {
    const ty = typeSuffix(ctx, t.next!, base);
    return arrayOf(ty, -1);
  }
  const n = Number(constExpr(ctx, t));
  t = ctx.t!;
  t = skip(t, "]");
  const ty = typeSuffix(ctx, t, base);
  return arrayOf(ty, n);
}

/** Applies function or array suffixes after the base type in a declarator. */
function typeSuffix(ctx: { t: Token | null }, tok: Token, ty: Type): Type {
  let t = tok;
  if (equal(t, "(")) return funcParams(ctx, t.next!, ty);
  if (equal(t, "[")) return arrayDimensions(ctx, t.next!, ty);
  ctx.t = t;
  return ty;
}

/** Consumes `*` and pointer qualifiers, wrapping `ty` in {@link TypeKind.Ptr}. */
function pointers(ctx: { t: Token | null }, tok: Token, ty: Type): Type {
  let t = tok;
  while (t && equal(t, "*")) {
    t = t.next!;
    ty = pointerTo(ty);
    while (
      t &&
      (equal(t, "const") ||
        equal(t, "volatile") ||
        equal(t, "restrict") ||
        equal(t, "__restrict") ||
        equal(t, "__restrict__"))
    )
      t = t.next!;
  }
  ctx.t = t;
  return ty;
}

/** Full declarator: pointers, optional parenthesized inner declarator, suffixes, and identifier. */
function declarator(ctx: { t: Token | null }, tok: Token, ty: Type): Type {
  ty = pointers(ctx, tok, ty);
  let t = ctx.t!;
  if (equal(t, "(")) {
    const start = t;
    const dummy = copyType(tyVoid);
    declarator(ctx, t.next!, dummy);
    t = skip(ctx.t!, ")");
    ty = typeSuffix(ctx, t, ty);
    return declarator(ctx, start.next!, ty);
  }
  let name: Token | null = null;
  const namePos = t;
  if (t.kind === TokenKind.Ident) {
    name = t;
    t = t.next!;
  }
  ty = typeSuffix(ctx, t, ty);
  ty.name = name;
  ty.namePos = namePos;
  return ty;
}

/** Declarator without requiring an identifier (sizeof, casts, abstract params). */
function abstractDeclarator(ctx: { t: Token | null }, tok: Token, ty: Type): Type {
  ty = pointers(ctx, tok, ty);
  let t = ctx.t!;
  if (equal(t, "(")) {
    const start = t;
    const dummy = copyType(tyVoid);
    abstractDeclarator(ctx, t.next!, dummy);
    t = skip(ctx.t!, ")");
    ty = typeSuffix(ctx, t, ty);
    return abstractDeclarator(ctx, start.next!, ty);
  }
  return typeSuffix(ctx, t, ty);
}

/** Parses one or more typedef declarators until `;`. */
function parseTypedef(ctx: { t: Token | null }, tok: Token, basety: Type): Token | null {
  ctx.t = tok;
  let first = true;
  for (;;) {
    if (ctx.t && equal(ctx.t, ";")) {
      ctx.t = ctx.t.next;
      break;
    }
    if (!first) ctx.t = skip(ctx.t!, ",");
    first = false;
    const ty = declarator(ctx, ctx.t!, basety);
    if (!ty.name) errorTok(ty.namePos!, "typedef name omitted");
    const vs = pushScopeVar(getIdent(ty.name));
    vs.typeDef = ty;
  }
  return ctx.t;
}

/** True if tokens starting at `tok` form a function declarator vs variable declaration. */
function isFunction(tok: Token): boolean {
  if (equal(tok, ";")) return false;
  const ctx = { t: tok as Token | null };
  const dummy = copyType(tyInt);
  const ty = declarator(ctx, tok, dummy);
  return ty.kind === TypeKind.Func;
}

/** Creates stack slots for each formal parameter type in declaration order. */
function createParamLvars(param: Type | null): void {
  if (!param) return;
  createParamLvars(param.next);
  if (!param.name) errorTok(param.namePos!, "parameter name omitted");
  newLvar(getIdent(param.name), param, param.name);
}

/** Looks up file-scope function symbol by name (outermost scope only). */
function findFunc(name: string): Obj | null {
  let sc: Scope | null = scope;
  while (sc?.next) sc = sc.next;
  const vs = sc?.vars.get(name);
  if (vs?.var?.isFunction) return vs.var;
  return null;
}

/** Parses a function declaration or definition: prototype, body, params, labels. */
function parseFunction(ctx: { t: Token | null }, tok: Token, basety: Type, attr: VarAttr): Token | null {
  const ty = declarator(ctx, tok, basety);
  let t = ctx.t!;
  if (!ty.name) errorTok(ty.namePos!, "function name omitted");
  const name = getIdent(ty.name);
  let fn = findFunc(name);
  if (fn) {
    if (!fn.isFunction) errorTok(tok, "redeclared as a different kind of symbol");
    if (fn.isDefinition && equal(t, "{")) errorTok(t, "redefinition of %s", name);
    if (!fn.isStatic && attr.isStatic) errorTok(t, "static declaration follows a non-static declaration");
    fn.isDefinition = fn.isDefinition || equal(t, "{");
  } else {
    fn = newGvar(name, ty);
    fn.isFunction = true;
    fn.isDefinition = equal(t, "{");
    fn.isStatic = attr.isStatic || (attr.isInline && !attr.isExtern);
    fn.isInline = attr.isInline;
  }
  fn.isRoot = !(fn.isStatic && fn.isInline);
  if (equal(t, ";")) {
    ctx.t = t.next;
    return ctx.t;
  }
  currentFn = fn;
  locals = null;
  enterScope();
  createParamLvars(ty.params);
  fn.params = locals;
  t = skip(t, "{");
  fn.body = compoundStmt(ctx, t);
  fn.locals = locals;
  t = ctx.t!;
  leaveScope();
  resolveLabels(fn.body);
  currentFn = null;
  ctx.t = t;
  return t;
}

/** Placeholder for forward goto resolution (unsupported in JS backend). */
function resolveLabels(_n: Node | null): void {
  /* goto unsupported in js backend for now */
}

/** Parses file-scope variables with optional initializers and tentative defs. */
function globalVariable(ctx: { t: Token | null }, tok: Token, basety: Type, attr: VarAttr): Token | null {
  ctx.t = tok;
  let first = true;
  for (;;) {
    if (ctx.t && equal(ctx.t, ";")) {
      ctx.t = ctx.t.next;
      break;
    }
    if (!first) ctx.t = skip(ctx.t!, ",");
    first = false;
    const ty = declarator(ctx, ctx.t!, basety);
    let p: Token | null = ctx.t;
    if (!p) errorTok(ty.namePos!, "internal parse error");
    if (!ty.name) errorTok(ty.namePos!, "variable name omitted");
    const name = getIdent(ty.name);
    const v = newGvar(name, ty);
    v.isStatic = attr.isStatic;
    v.isDefinition = !attr.isExtern;
    if (attr.align) v.align = attr.align;
    if (equal(p, "=")) {
      if (ty.kind === TypeKind.Array && p.next?.kind === TokenKind.Str) {
        const st: Token = p.next;
        p = st.next!;
        const bytes = st.str!;
        v.initData = new Uint8Array(bytes.length + 1);
        v.initData.set(bytes);
      } else {
        const val = constExpr(ctx, p.next!);
        p = ctx.t!;
        const buf = new Uint8Array(ty.size);
        const view = new DataView(buf.buffer);
        if (ty.kind === TypeKind.Ptr) {
          /* pointer constant not in const expr */
        } else if (isInteger(ty)) {
          const n = BigInt.asIntN(ty.size * 8, val);
          if (ty.size === 1) buf[0] = Number(n) & 0xff;
          else if (ty.size === 2) view.setInt16(0, Number(n), true);
          else if (ty.size === 4) view.setInt32(0, Number(n), true);
          else view.setBigInt64(0, n, true);
        }
        v.initData = buf;
      }
    } else if (!attr.isExtern && !attr.isTls) v.isTentative = true;
    ctx.t = p;
  }
  return ctx.t;
}

/** `{ ... }` block: declarations and statements until `}`; manages scope. */
function compoundStmt(ctx: { t: Token | null }, tok: Token): Node | null {
  const node = newNode(NodeKind.Block, tok);
  enterScope();
  let t = tok;
  let head: Node | null = null;
  let cur: Node | null = null;
  while (!equal(t, "}")) {
    if (isTypename(t) || equal(t, "static")) {
      const n = declaration(ctx, t);
      t = ctx.t!;
      if (n) {
        if (!head) head = n;
        else cur!.next = n;
        cur = n;
        while (cur && cur.next) cur = cur.next;
      }
    } else {
      const n = stmt(ctx, t);
      t = ctx.t!;
      if (n) {
        if (!head) head = n;
        else cur!.next = n;
        cur = n;
        while (cur && cur.next) cur = cur.next;
      }
    }
  }
  t = skip(t, "}");
  leaveScope();
  node.body = head;
  ctx.t = t;
  return node;
}

/** Local declaration line (possibly multiple declarators) inside a block. */
function declaration(ctx: { t: Token | null }, tok: Token): Node | null {
  const attr: VarAttr = {
    isTypedef: false,
    isStatic: false,
    isExtern: false,
    isInline: false,
    isTls: false,
    align: 0,
  };
  ctx.t = tok;
  if (ctx.t && equal(ctx.t, "static")) {
    attr.isStatic = true;
    ctx.t = ctx.t.next;
  }
  const basety = declspec(ctx, ctx.t!, attr);
  if (attr.isTypedef) return parseTypedef(ctx, ctx.t!, basety) as unknown as Node | null;
  let first = true;
  let head: Node | null = null;
  let cur: Node | null = null;
  for (;;) {
    if (ctx.t && equal(ctx.t, ";")) {
      ctx.t = ctx.t.next;
      break;
    }
    if (!first) ctx.t = skip(ctx.t!, ",");
    first = false;
    const ty = declarator(ctx, ctx.t!, basety);
    let t = ctx.t!;
    if (!ty.name) errorTok(ty.namePos!, "variable name omitted");
    const v = attr.isStatic ? newGvar(getIdent(ty.name), ty) : newLvar(getIdent(ty.name), ty, ty.name);
    if (attr.isStatic) {
      v.isStatic = true;
      v.isDefinition = true;
    }
    if (equal(t, "=")) {
      const rhs = assign(ctx, t.next!);
      t = ctx.t!;
      const n = newBinary(NodeKind.Assign, newVarNode(v, ty.name), rhs, ty.name);
      const es = newNode(NodeKind.ExprStmt, ty.name);
      es.lhs = n;
      if (!head) head = es;
      else cur!.next = es;
      cur = es;
    }
    ctx.t = t;
  }
  return head;
}

/**
 * Statement parser: compound, selection, iteration, switch, jump, or expression statement.
 */
function stmt(ctx: { t: Token | null }, tok: Token): Node | null {
  let t = tok;
  if (equal(t, "{")) return compoundStmt(ctx, t.next!);
  if (equal(t, "if")) {
    t = skip(t.next!, "(");
    const cond = expr(ctx, t);
    t = ctx.t!;
    t = skip(t, ")");
    const th = stmt(ctx, t);
    t = ctx.t!;
    const node = newNode(NodeKind.If, tok);
    node.cond = cond;
    node.then = th;
    if (equal(t, "else")) {
      node.els = stmt(ctx, t.next!);
      t = ctx.t!;
    }
    ctx.t = t;
    return node;
  }
  if (equal(t, "while")) {
    t = skip(t.next!, "(");
    const cond = expr(ctx, t);
    t = ctx.t!;
    t = skip(t, ")");
    const brk = newUniqueName();
    const cont = newUniqueName();
    const prevB = brkLabel;
    const prevC = contLabel;
    brkLabel = brk;
    contLabel = cont;
    const body = stmt(ctx, t);
    t = ctx.t!;
    brkLabel = prevB;
    contLabel = prevC;
    const node = newNode(NodeKind.For, tok);
    node.cond = cond;
    node.then = body;
    node.brkLabel = brk;
    node.contLabel = cont;
    return node;
  }
  if (equal(t, "for")) {
    t = skip(t.next!, "(");
    enterScope();
    let init: Node | null = null;
    if (!equal(t, ";")) {
      if (isTypename(t)) init = declaration(ctx, t);
      else {
        init = exprStmt(ctx, t);
        t = ctx.t!;
      }
    } else t = t.next!;
    let cond: Node | null = null;
    if (!equal(t, ";")) {
      cond = expr(ctx, t);
      t = ctx.t!;
    }
    t = skip(t, ";");
    let inc: Node | null = null;
    if (!equal(t, ")")) {
      inc = expr(ctx, t);
      t = ctx.t!;
    }
    t = skip(t, ")");
    const brk = newUniqueName();
    const cont = newUniqueName();
    const prevB = brkLabel;
    const prevC = contLabel;
    brkLabel = brk;
    contLabel = cont;
    const body = stmt(ctx, t);
    t = ctx.t!;
    brkLabel = prevB;
    contLabel = prevC;
    leaveScope();
    const node = newNode(NodeKind.For, tok);
    node.init = init;
    node.cond = cond;
    node.inc = inc;
    node.then = body;
    node.brkLabel = brk;
    node.contLabel = cont;
    return node;
  }
  if (equal(t, "switch")) {
    t = skip(t.next!, "(");
    const cond = expr(ctx, t);
    t = ctx.t!;
    t = skip(t, ")");
    const lbrace = t;
    t = skip(t, "{");
    const sw = newNode(NodeKind.Switch, tok);
    sw.cond = cond;
    const brk = newUniqueName();
    const prevB = brkLabel;
    brkLabel = brk;
    sw.brkLabel = brk;
    enterScope();
    const block = newNode(NodeKind.Block, lbrace);
    let head: Node | null = null;
    let cur: Node | null = null;
    const append = (n: Node | null): void => {
      if (!n) return;
      if (!head) head = n;
      else cur!.next = n;
      cur = n;
      while (cur!.next) cur = cur.next;
    };
    const parseCaseStmts = (): { t: Token; head: Node | null } => {
      let stHead: Node | null = null;
      let stCur: Node | null = null;
      while (!equal(t, "}") && !equal(t, "case") && !equal(t, "default")) {
        const st = stmt(ctx, t);
        t = ctx.t!;
        if (!st) continue;
        if (!stHead) stHead = st;
        else stCur!.next = st;
        stCur = st;
        while (stCur!.next) stCur = stCur.next;
      }
      return { t, head: stHead };
    };
    while (!equal(t, "}")) {
      if (isTypename(t) || equal(t, "static")) {
        const n = declaration(ctx, t);
        t = ctx.t!;
        append(n);
        continue;
      }
      if (equal(t, "case")) {
        const caseTok = t;
        t = t.next!;
        const val = constExpr(ctx, t);
        t = ctx.t!;
        t = skip(t, ":");
        const cn = newNode(NodeKind.Case, caseTok);
        cn.begin = val;
        const parsed = parseCaseStmts();
        t = parsed.t;
        cn.body = parsed.head;
        append(cn);
        continue;
      }
      if (equal(t, "default")) {
        if (sw.defaultCase) errorTok(t, "duplicate default");
        t = skip(t.next!, ":");
        const parsed = parseCaseStmts();
        t = parsed.t;
        sw.defaultCase = parsed.head;
        continue;
      }
      errorTok(t, "invalid statement in switch body");
    }
    t = skip(t, "}");
    block.body = head;
    sw.body = block;
    leaveScope();
    brkLabel = prevB;
    ctx.t = t;
    return sw;
  }
  if (equal(t, "return")) {
    const node = newNode(NodeKind.Return, t);
    if (equal(t.next!, ";")) {
      t = t.next!.next!;
      ctx.t = t;
      return node;
    }
    node.lhs = expr(ctx, t.next!);
    t = ctx.t!;
    t = skip(t, ";");
    ctx.t = t;
    return node;
  }
  if (equal(t, "break")) {
    if (!brkLabel) errorTok(t, "stray break");
    const node = newNode(NodeKind.Break, t);
    node.brkLabel = brkLabel;
    t = skip(t.next!, ";");
    ctx.t = t;
    return node;
  }
  if (equal(t, "continue")) {
    if (!contLabel) errorTok(t, "stray continue");
    const node = newNode(NodeKind.Continue, t);
    node.contLabel = contLabel;
    t = skip(t.next!, ";");
    ctx.t = t;
    return node;
  }
  return exprStmt(ctx, t);
}

/** Expression followed by `;` (optional empty becomes null expr in caller patterns). */
function exprStmt(ctx: { t: Token | null }, tok: Token): Node | null {
  const node = newNode(NodeKind.ExprStmt, tok);
  node.lhs = expr(ctx, tok);
  const t = skip(ctx.t!, ";");
  ctx.t = t;
  return node;
}

/** Top-level expression: comma is lowest parsed here (delegates to assign). */
function expr(ctx: { t: Token | null }, tok: Token): Node {
  return assign(ctx, tok);
}

/** Assignment expression (`=` only at this precedence level). */
function assign(ctx: { t: Token | null }, tok: Token): Node {
  let node = logor(ctx, tok);
  let t = ctx.t!;
  if (equal(t, "=")) {
    node = newBinary(NodeKind.Assign, node, assign(ctx, t.next!), t);
    t = ctx.t!;
  }
  ctx.t = t;
  return node;
}

/** Logical OR (`||`). */
function logor(ctx: { t: Token | null }, tok: Token): Node {
  let node = logand(ctx, tok);
  let t = ctx.t!;
  while (equal(t, "||")) {
    node = newBinary(NodeKind.LogOr, node, logand(ctx, t.next!), t);
    t = ctx.t!;
  }
  ctx.t = t;
  return node;
}

/** Logical AND (`&&`). */
function logand(ctx: { t: Token | null }, tok: Token): Node {
  let node = bitor(ctx, tok);
  let t = ctx.t!;
  while (equal(t, "&&")) {
    node = newBinary(NodeKind.LogAnd, node, bitor(ctx, t.next!), t);
    t = ctx.t!;
  }
  ctx.t = t;
  return node;
}

/** Bitwise inclusive OR. */
function bitor(ctx: { t: Token | null }, tok: Token): Node {
  let node = bitxor(ctx, tok);
  let t = ctx.t!;
  while (equal(t, "|")) {
    node = newBinary(NodeKind.BitOr, node, bitxor(ctx, t.next!), t);
    t = ctx.t!;
  }
  ctx.t = t;
  return node;
}

/** Bitwise XOR. */
function bitxor(ctx: { t: Token | null }, tok: Token): Node {
  let node = bitand(ctx, tok);
  let t = ctx.t!;
  while (equal(t, "^")) {
    node = newBinary(NodeKind.BitXor, node, bitand(ctx, t.next!), t);
    t = ctx.t!;
  }
  ctx.t = t;
  return node;
}

/** Bitwise AND. */
function bitand(ctx: { t: Token | null }, tok: Token): Node {
  let node = equality(ctx, tok);
  let t = ctx.t!;
  while (equal(t, "&")) {
    node = newBinary(NodeKind.BitAnd, node, equality(ctx, t.next!), t);
    t = ctx.t!;
  }
  ctx.t = t;
  return node;
}

/** `==` and `!=`. */
function equality(ctx: { t: Token | null }, tok: Token): Node {
  let node = relational(ctx, tok);
  let t = ctx.t!;
  for (;;) {
    if (equal(t, "==")) {
      node = newBinary(NodeKind.Eq, node, relational(ctx, t.next!), t);
      t = ctx.t!;
    } else if (equal(t, "!=")) {
      node = newBinary(NodeKind.Ne, node, relational(ctx, t.next!), t);
      t = ctx.t!;
    } else break;
  }
  ctx.t = t;
  return node;
}

/** Relational and ordering operators (`<` `>` `<=` `>=`). */
function relational(ctx: { t: Token | null }, tok: Token): Node {
  let node = add(ctx, tok);
  let t = ctx.t!;
  for (;;) {
    if (equal(t, "<")) {
      node = newBinary(NodeKind.Lt, node, add(ctx, t.next!), t);
      t = ctx.t!;
    } else if (equal(t, "<=")) {
      node = newBinary(NodeKind.Le, node, add(ctx, t.next!), t);
      t = ctx.t!;
    } else if (equal(t, ">")) {
      node = newBinary(NodeKind.Lt, add(ctx, t.next!), node, t);
      t = ctx.t!;
    } else if (equal(t, ">=")) {
      node = newBinary(NodeKind.Le, add(ctx, t.next!), node, t);
      t = ctx.t!;
    } else break;
  }
  ctx.t = t;
  return node;
}

/** Additive `+` / `-` with pointer arithmetic lowering. */
function add(ctx: { t: Token | null }, tok: Token): Node {
  let node = mul(ctx, tok);
  let t = ctx.t!;
  for (;;) {
    if (equal(t, "+")) {
      node = newAdd(node, mul(ctx, t.next!), t);
      t = ctx.t!;
    } else if (equal(t, "-")) {
      node = newSub(node, mul(ctx, t.next!), t);
      t = ctx.t!;
    } else break;
  }
  ctx.t = t;
  return node;
}

/** Builds Add node, inserting casts for pointer + integer forms. */
function newAdd(lhs: Node, rhs: Node, tok: Token | null): Node {
  addType(lhs);
  addType(rhs);
  if (lhs.ty!.kind === TypeKind.Ptr && isInteger(rhs.ty!))
    return newBinary(NodeKind.Add, lhs, newCast(rhs, tyLong), tok);
  if (isInteger(lhs.ty!) && rhs.ty!.kind === TypeKind.Ptr)
    return newBinary(NodeKind.Add, newCast(lhs, tyLong), rhs, tok);
  return newBinary(NodeKind.Add, lhs, rhs, tok);
}

/** Builds Sub node (pointer minus integer, or arithmetic sub). */
function newSub(lhs: Node, rhs: Node, tok: Token | null): Node {
  addType(lhs);
  addType(rhs);
  if (lhs.ty!.kind === TypeKind.Ptr && isInteger(rhs.ty!))
    return newBinary(NodeKind.Sub, lhs, newCast(rhs, tyLong), tok);
  return newBinary(NodeKind.Sub, lhs, rhs, tok);
}

/** Multiplicative `*` `/` `%`. */
function mul(ctx: { t: Token | null }, tok: Token): Node {
  let node = unary(ctx, tok);
  let t = ctx.t!;
  for (;;) {
    if (equal(t, "*")) {
      node = newBinary(NodeKind.Mul, node, unary(ctx, t.next!), t);
      t = ctx.t!;
    } else if (equal(t, "/")) {
      node = newBinary(NodeKind.Div, node, unary(ctx, t.next!), t);
      t = ctx.t!;
    } else if (equal(t, "%")) {
      node = newBinary(NodeKind.Mod, node, unary(ctx, t.next!), t);
      t = ctx.t!;
    } else break;
  }
  ctx.t = t;
  return node;
}

/** Unary operators, `sizeof`, and delegation to postfix. */
function unary(ctx: { t: Token | null }, tok: Token): Node {
  let t = tok;
  if (equal(t, "+")) return unary(ctx, t.next!);
  if (equal(t, "-")) return newUnary(NodeKind.Neg, unary(ctx, t.next!), t);
  if (equal(t, "&")) return newUnary(NodeKind.Addr, unary(ctx, t.next!), t);
  if (equal(t, "*")) {
    const n = unary(ctx, t.next!);
    addType(n);
    if (n.ty!.kind === TypeKind.Func) {
      ctx.t = ctx.t;
      return n;
    }
    return newUnary(NodeKind.Deref, n, t);
  }
  if (equal(t, "!")) return newUnary(NodeKind.Not, cast(ctx, t.next!), t);
  if (equal(t, "~")) return newUnary(NodeKind.BitNot, cast(ctx, t.next!), t);
  if (equal(t, "sizeof") && equal(t.next!, "(") && isTypename(t.next!.next!)) {
    const ty = typename(ctx, t.next!.next!);
    ctx.t = skip(ctx.t!, ")");
    return newNum(BigInt(ty.size), t);
  }
  if (equal(t, "sizeof")) {
    const n = unary(ctx, t.next!);
    addType(n);
    ctx.t = ctx.t;
    return newNum(BigInt(n.ty!.size), t);
  }
  return postfix(ctx, t);
}

/** Casts `(type)` or falls through to unary/postfix. */
function cast(ctx: { t: Token | null }, tok: Token): Node {
  let t = tok;
  if (equal(t, "(") && isTypename(t.next)) {
    const ty = typename(ctx, t.next!);
    t = ctx.t!;
    t = skip(t, ")");
    return newCast(unary(ctx, t), ty);
  }
  return postfix(ctx, t);
}

/** Postfix chain: calls, subscript, `.` and `->`. */
function postfix(ctx: { t: Token | null }, tok: Token): Node {
  let node = primary(ctx, tok);
  let t = ctx.t!;
  for (;;) {
    if (equal(t, "(")) {
      node = funcall(ctx, t.next!, node);
      t = ctx.t!;
      continue;
    }
    if (equal(t, "[")) {
      const st = t;
      const idx = expr(ctx, t.next!);
      t = ctx.t!;
      t = skip(t, "]");
      node = newUnary(NodeKind.Deref, newAdd(node, idx, st), st);
      continue;
    }
    if (equal(t, ".")) {
      node = structRef(node, t.next!);
      t = t.next!.next!;
      continue;
    }
    if (equal(t, "->")) {
      node = newUnary(NodeKind.Deref, node, t);
      node = structRef(node, t.next!);
      t = t.next!.next!;
      continue;
    }
    break;
  }
  ctx.t = t;
  return node;
}

/** Finds member `name` on struct/union type `ty`. */
function getStructMember(ty: Type, name: string): Member | null {
  for (let m = ty.members; m; m = m.next) {
    if (m.name === name) return m;
  }
  return null;
}

/** Builds Member node for `.field` / `->field` after type-checking aggregate. */
function structRef(node: Node, tok: Token): Node {
  addType(node);
  const ty = node.ty!;
  if (ty.kind !== TypeKind.Struct && ty.kind !== TypeKind.Union) errorTok(node.tok!, "not a struct nor a union");
  const name = getIdent(tok);
  const mem = getStructMember(ty, name);
  if (!mem) errorTok(tok, "no such member");
  const n = newUnary(NodeKind.Member, node, tok);
  n.member = mem;
  return n;
}

/** Parses argument list and builds {@link NodeKind.Funcall}. */
function funcall(ctx: { t: Token | null }, tok: Token, fn: Node): Node {
  addType(fn);
  let t = tok;
  const head: Node = newNode(NodeKind.NullExpr, t);
  let cur = head;
  while (!equal(t, ")")) {
    if (cur !== head) t = skip(t, ",");
    const arg = assign(ctx, t);
    t = ctx.t!;
    cur.next = arg;
    cur = arg;
  }
  t = skip(t, ")");
  const node = newNode(NodeKind.Funcall, fn.tok);
  node.lhs = fn;
  node.args = head.next;
  if (fn.kind === NodeKind.Var && fn.var!.ty.kind === TypeKind.Func) node.funcTy = fn.var!.ty;
  else if (fn.ty?.kind === TypeKind.Ptr && fn.ty.base?.kind === TypeKind.Func) node.funcTy = fn.ty.base;
  else errorTok(fn.tok!, "not a function");
  ctx.t = t;
  return node;
}

/** Primary expressions: literals, identifiers, parens, compound literals via cast. */
function primary(ctx: { t: Token | null }, tok: Token): Node {
  let t = tok;
  if (equal(t, "(") && isTypename(t.next)) {
    const ty = typename(ctx, t.next!);
    t = ctx.t!;
    t = skip(t, ")");
    return newCast(unary(ctx, t), ty);
  }
  if (equal(t, "(")) {
    const node = expr(ctx, t.next!);
    t = ctx.t!;
    t = skip(t, ")");
    ctx.t = t;
    return node;
  }
  if (t.kind === TokenKind.Ident) {
    const name = getIdent(t);
    const sc = findVar(name);
    ctx.t = t.next;
    if (sc?.var) return newVarNode(sc.var, t);
    if (sc?.enumTy) return newNum(BigInt(sc.enumVal), t);
    if (equal(t.next!, "(")) errorTok(t, "implicit declaration of a function");
    errorTok(t, "undefined variable");
  }
  if (t.kind === TokenKind.Str) {
    const v = newStringLiteral(t.str!, t.ty!);
    ctx.t = t.next;
    return newVarNode(v, t);
  }
  if (t.kind === TokenKind.Num) {
    const node = newNode(NodeKind.Num, t);
    node.val = t.val;
    node.fval = t.fval;
    node.ty = t.ty;
    ctx.t = t.next;
    return node;
  }
  errorTok(t, "expected an expression");
}

/** Parses an expression that must fold to an integer constant. */
function constExpr(ctx: { t: Token | null }, tok: Token): bigint {
  const n = evalRval(expr(ctx, tok));
  ctx.t = ctx.t;
  return n;
}

/** Evaluates a constant AST subtree for array lengths and enum values. */
function evalRval(node: Node): bigint {
  addType(node);
  switch (node.kind) {
    case NodeKind.Num:
      return node.val;
    case NodeKind.Add:
      return evalRval(node.lhs!) + evalRval(node.rhs!);
    case NodeKind.Sub:
      return evalRval(node.lhs!) - evalRval(node.rhs!);
    case NodeKind.Mul:
      return evalRval(node.lhs!) * evalRval(node.rhs!);
    case NodeKind.Div:
      return evalRval(node.lhs!) / evalRval(node.rhs!);
    case NodeKind.Mod:
      return evalRval(node.lhs!) % evalRval(node.rhs!);
    case NodeKind.Cast:
      return evalRval(node.lhs!);
    default:
      errorTok(node.tok!, "not a constant expression");
  }
}
