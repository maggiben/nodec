/** Core AST and type definitions. */

export type File = {
  name: string;
  displayName: string;
  fileNo: number;
  contents: string;
  lineDelta: number;
};

export const enum TokenKind {
  Ident = "Ident",
  Punct = "Punct",
  Keyword = "Keyword",
  Str = "Str",
  Num = "Num",
  PpNum = "PpNum",
  Eof = "Eof",
}

export type Token = {
  kind: TokenKind;
  next: Token | null;
  val: bigint;
  fval: number;
  loc: number;
  len: number;
  ty: Type | null;
  /** Decoded string bytes for char string literals (includes no trailing 0 in storage here; init uses length) */
  str: Uint8Array | null;
  file: File;
  filename: string;
  lineNo: number;
  lineDelta: number;
  atBol: boolean;
  hasSpace: boolean;
};

export type Relocation = {
  next: Relocation | null;
  offset: number;
  label: string;
  addend: number;
};

export type Obj = {
  next: Obj | null;
  name: string;
  ty: Type;
  tok: Token | null;
  isLocal: boolean;
  align: number;
  offset: number;
  isFunction: boolean;
  isDefinition: boolean;
  isStatic: boolean;
  isTentative: boolean;
  isTls: boolean;
  initData: Uint8Array | null;
  rel: Relocation | null;
  isInline: boolean;
  params: Obj | null;
  body: Node | null;
  locals: Obj | null;
  vaArea: Obj | null;
  allocaBottom: Obj | null;
  stackSize: number;
  isLive: boolean;
  isRoot: boolean;
  refs: string[];
};

export const enum NodeKind {
  NullExpr = "NullExpr",
  Add = "Add",
  Sub = "Sub",
  Mul = "Mul",
  Div = "Div",
  Neg = "Neg",
  Mod = "Mod",
  BitAnd = "BitAnd",
  BitOr = "BitOr",
  BitXor = "BitXor",
  Shl = "Shl",
  Shr = "Shr",
  Eq = "Eq",
  Ne = "Ne",
  Lt = "Lt",
  Le = "Le",
  Assign = "Assign",
  Cond = "Cond",
  Comma = "Comma",
  Member = "Member",
  Addr = "Addr",
  Deref = "Deref",
  Not = "Not",
  BitNot = "BitNot",
  LogAnd = "LogAnd",
  LogOr = "LogOr",
  Return = "Return",
  If = "If",
  For = "For",
  Do = "Do",
  Switch = "Switch",
  Case = "Case",
  Block = "Block",
  Goto = "Goto",
  GotoExpr = "GotoExpr",
  Label = "Label",
  LabelVal = "LabelVal",
  Funcall = "Funcall",
  ExprStmt = "ExprStmt",
  StmtExpr = "StmtExpr",
  Var = "Var",
  VlaPtr = "VlaPtr",
  Num = "Num",
  Cast = "Cast",
  MemZero = "MemZero",
  Asm = "Asm",
  Cas = "Cas",
  Exch = "Exch",
  Break = "Break",
  Continue = "Continue",
}

export type Node = {
  kind: NodeKind;
  next: Node | null;
  ty: Type | null;
  tok: Token | null;
  lhs: Node | null;
  rhs: Node | null;
  cond: Node | null;
  then: Node | null;
  els: Node | null;
  init: Node | null;
  inc: Node | null;
  brkLabel: string | null;
  contLabel: string | null;
  body: Node | null;
  member: Member | null;
  funcTy: Type | null;
  args: Node | null;
  passByStack: boolean;
  retBuffer: Obj | null;
  label: string | null;
  uniqueLabel: string | null;
  gotoNext: Node | null;
  caseNext: Node | null;
  defaultCase: Node | null;
  begin: bigint;
  end: bigint;
  asmStr: string | null;
  casAddr: Node | null;
  casOld: Node | null;
  casNew: Node | null;
  atomicAddr: Obj | null;
  atomicExpr: Node | null;
  var: Obj | null;
  val: bigint;
  fval: number;
};

export type Member = {
  next: Member | null;
  ty: Type;
  tok: Token | null;
  name: string | null;
  idx: number;
  align: number;
  offset: number;
  isBitfield: boolean;
  bitOffset: number;
  bitWidth: number;
};

export const enum TypeKind {
  Void = "Void",
  Bool = "Bool",
  Char = "Char",
  Short = "Short",
  Int = "Int",
  Long = "Long",
  Float = "Float",
  Double = "Double",
  LDouble = "LDouble",
  Enum = "Enum",
  Ptr = "Ptr",
  Func = "Func",
  Array = "Array",
  Vla = "Vla",
  Struct = "Struct",
  Union = "Union",
}

export type Type = {
  kind: TypeKind;
  size: number;
  align: number;
  isUnsigned: boolean;
  isAtomic: boolean;
  origin: Type | null;
  base: Type | null;
  name: Token | null;
  namePos: Token | null;
  arrayLen: number;
  vlaLen: Node | null;
  vlaSize: Obj | null;
  members: Member | null;
  isFlexible: boolean;
  isPacked: boolean;
  returnTy: Type | null;
  params: Type | null;
  isVariadic: boolean;
  next: Type | null;
  /** Struct tag for forward references */
  tag: string | null;
  isComplete: boolean;
};

/** Allocates a complete {@link Type} shell with default fields for the given kind/size/align. */
function newType(kind: TypeKind, size: number, align: number): Type {
  return {
    kind,
    size,
    align,
    isUnsigned: false,
    isAtomic: false,
    origin: null,
    base: null,
    name: null,
    namePos: null,
    arrayLen: 0,
    vlaLen: null,
    vlaSize: null,
    members: null,
    isFlexible: false,
    isPacked: false,
    returnTy: null,
    params: null,
    isVariadic: false,
    next: null,
    tag: null,
    isComplete: true,
  };
}

export const tyVoid = newType(TypeKind.Void, 1, 1);
export const tyBool = newType(TypeKind.Bool, 1, 1);
export const tyChar = newType(TypeKind.Char, 1, 1);
export const tyShort = newType(TypeKind.Short, 2, 2);
export const tyInt = newType(TypeKind.Int, 4, 4);
export const tyLong = newType(TypeKind.Long, 8, 8);
const _uc = newType(TypeKind.Char, 1, 1);
_uc.isUnsigned = true;
export const tyUchar = _uc;
const _us = newType(TypeKind.Short, 2, 2);
_us.isUnsigned = true;
export const tyUshort = _us;
const _ui = newType(TypeKind.Int, 4, 4);
_ui.isUnsigned = true;
export const tyUint = _ui;
const _ul = newType(TypeKind.Long, 8, 8);
_ul.isUnsigned = true;
export const tyUlong = _ul;
export const tyFloat = newType(TypeKind.Float, 4, 4);
export const tyDouble = newType(TypeKind.Double, 8, 8);
export const tyLdouble = newType(TypeKind.LDouble, 16, 16);

/** Shallow copy tagged with `origin` pointing at the canonical type (typedef decay). */
export function copyType(ty: Type): Type {
  return { ...ty, origin: ty };
}

/** Pointer type `T *` with platform pointer size/align. */
export function pointerTo(base: Type): Type {
  const ty = newType(TypeKind.Ptr, 8, 8);
  ty.base = base;
  ty.isUnsigned = true;
  return ty;
}

/** Incomplete function type; attach `params` and `isVariadic` separately. */
export function funcType(returnTy: Type): Type {
  const ty = newType(TypeKind.Func, 1, 1);
  ty.returnTy = returnTy;
  return ty;
}

/**
 * Array type `base[len]`; `len < 0` means incomplete (unknown length, size 0 here).
 * @param len Element count, or negative for `[]`.
 */
export function arrayOf(base: Type, len: number): Type {
  const sz = len < 0 ? 0 : base.size * len;
  const ty = newType(TypeKind.Array, sz, base.align);
  ty.base = base;
  ty.arrayLen = len;
  return ty;
}

/** Enum type placeholder (values stored as int-sized in this compiler). */
export function enumType(): Type {
  return newType(TypeKind.Enum, 4, 4);
}

/** Incomplete struct type until members are parsed. */
export function structType(): Type {
  const ty = newType(TypeKind.Struct, 0, 1);
  ty.isComplete = false;
  return ty;
}

/** Incomplete union type until members are parsed. */
export function unionType(): Type {
  const ty = newType(TypeKind.Union, 0, 1);
  ty.isComplete = false;
  return ty;
}
