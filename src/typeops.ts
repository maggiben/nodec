import {
  type Node,
  type Type,
  TypeKind,
  NodeKind,
  tyDouble,
  tyFloat,
  tyInt,
  tyLdouble,
  tyLong,
  tyUint,
  tyUlong,
  tyVoid,
  copyType,
  pointerTo,
} from "./ctypes.js";
import { errorTok } from "./diag.js";

export function isInteger(ty: Type): boolean {
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

export function isFlonum(ty: Type): boolean {
  return ty.kind === TypeKind.Float || ty.kind === TypeKind.Double || ty.kind === TypeKind.LDouble;
}

export function isNumeric(ty: Type): boolean {
  return isInteger(ty) || isFlonum(ty);
}

export function isCompatible(t1: Type, t2: Type): boolean {
  if (t1 === t2) return true;
  if (t1.origin) return isCompatible(t1.origin, t2);
  if (t2.origin) return isCompatible(t1, t2.origin);
  if (t1.kind !== t2.kind) return false;
  switch (t1.kind) {
    case TypeKind.Char:
    case TypeKind.Short:
    case TypeKind.Int:
    case TypeKind.Long:
      return t1.isUnsigned === t2.isUnsigned;
    case TypeKind.Float:
    case TypeKind.Double:
    case TypeKind.LDouble:
      return true;
    case TypeKind.Ptr:
      return t1.base && t2.base ? isCompatible(t1.base, t2.base) : false;
    case TypeKind.Func: {
      if (!isCompatible(t1.returnTy!, t2.returnTy!)) return false;
      if (t1.isVariadic !== t2.isVariadic) return false;
      let p1 = t1.params;
      let p2 = t2.params;
      while (p1 && p2) {
        if (!isCompatible(p1, p2)) return false;
        p1 = p1.next;
        p2 = p2.next;
      }
      return p1 === null && p2 === null;
    }
    case TypeKind.Array:
      if (!t1.base || !t2.base || !isCompatible(t1.base, t2.base)) return false;
      return t1.arrayLen < 0 && t2.arrayLen < 0 && t1.arrayLen === t2.arrayLen;
    default:
      return false;
  }
}

function newCast(expr: Node, ty: Type): Node {
  addType(expr);
  return {
    kind: NodeKind.Cast,
    next: null,
    ty,
    tok: expr.tok,
    lhs: expr,
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

function getCommonType(ty1: Type, ty2: Type): Type {
  if (ty1.base) return pointerTo(ty1.base!);
  if (ty1.kind === TypeKind.Func) return pointerTo(ty1);
  if (ty2.kind === TypeKind.Func) return pointerTo(ty2);
  if (ty1.kind === TypeKind.LDouble || ty2.kind === TypeKind.LDouble) return tyLdouble;
  if (ty1.kind === TypeKind.Double || ty2.kind === TypeKind.Double) return tyDouble;
  if (ty1.kind === TypeKind.Float || ty2.kind === TypeKind.Float) return tyFloat;
  let a = ty1.size < 4 ? tyInt : ty1;
  let b = ty2.size < 4 ? tyInt : ty2;
  if (a.size !== b.size) return a.size < b.size ? b : a;
  if (b.isUnsigned) return b;
  return a;
}

function usualArithConv(lhs: Node, rhs: Node): Type {
  return getCommonType(lhs.ty!, rhs.ty!);
}

export function addType(node: Node | null): void {
  if (!node || node.ty) return;
  addType(node.lhs);
  addType(node.rhs);
  addType(node.cond);
  addType(node.then);
  addType(node.els);
  addType(node.init);
  addType(node.inc);
  for (let n = node.body; n; n = n.next) addType(n);
  for (let n = node.args; n; n = n.next) addType(n);

  switch (node.kind) {
    case NodeKind.Num:
      if (!node.ty) node.ty = tyInt;
      return;
    case NodeKind.Add:
    case NodeKind.Sub:
    case NodeKind.Mul:
    case NodeKind.Div:
    case NodeKind.Mod:
    case NodeKind.BitAnd:
    case NodeKind.BitOr:
    case NodeKind.BitXor: {
      const ty = usualArithConv(node.lhs!, node.rhs!);
      node.lhs = newCast(node.lhs!, ty);
      node.rhs = newCast(node.rhs!, ty);
      node.ty = ty;
      return;
    }
    case NodeKind.Neg: {
      const ty = getCommonType(tyInt, node.lhs!.ty!);
      node.lhs = newCast(node.lhs!, ty);
      node.ty = ty;
      return;
    }
    case NodeKind.Assign:
      if (node.lhs!.ty!.kind === TypeKind.Array) errorTok(node.lhs!.tok!, "not an lvalue");
      if (node.lhs!.ty!.kind !== TypeKind.Struct && node.lhs!.ty!.kind !== TypeKind.Union)
        node.rhs = newCast(node.rhs!, node.lhs!.ty!);
      node.ty = node.lhs!.ty;
      return;
    case NodeKind.Eq:
    case NodeKind.Ne:
    case NodeKind.Lt:
    case NodeKind.Le: {
      const ty = usualArithConv(node.lhs!, node.rhs!);
      node.lhs = newCast(node.lhs!, ty);
      node.rhs = newCast(node.rhs!, ty);
      node.ty = tyInt;
      return;
    }
    case NodeKind.Funcall:
      for (let a = node.args; a; a = a.next) addType(a);
      node.ty = node.funcTy!.returnTy;
      return;
    case NodeKind.Not:
    case NodeKind.LogOr:
    case NodeKind.LogAnd:
      node.ty = tyInt;
      return;
    case NodeKind.BitNot:
    case NodeKind.Shl:
    case NodeKind.Shr:
      node.ty = node.lhs!.ty;
      return;
    case NodeKind.Var:
    case NodeKind.VlaPtr:
      node.ty = node.var!.ty;
      return;
    case NodeKind.Cond:
      if (node.then!.ty!.kind === TypeKind.Void || node.els!.ty!.kind === TypeKind.Void) {
        node.ty = tyVoid;
      } else {
        const ty = usualArithConv(node.then!, node.els!);
        node.then = newCast(node.then!, ty);
        node.els = newCast(node.els!, ty);
        node.ty = ty;
      }
      return;
    case NodeKind.Comma:
      node.ty = node.rhs!.ty;
      return;
    case NodeKind.Member:
      addType(node.lhs);
      node.ty = node.member!.ty;
      return;
    case NodeKind.Addr: {
      const ty = node.lhs!.ty!;
      if (ty.kind === TypeKind.Array) node.ty = pointerTo(ty.base!);
      else node.ty = pointerTo(ty);
      return;
    }
    case NodeKind.Deref:
      if (!node.lhs!.ty!.base) errorTok(node.tok!, "invalid pointer dereference");
      if (node.lhs!.ty!.base!.kind === TypeKind.Void)
        errorTok(node.tok!, "dereferencing a void pointer");
      node.ty = node.lhs!.ty!.base!;
      return;
    case NodeKind.Cast:
      addType(node.lhs);
      return;
    case NodeKind.ExprStmt:
      addType(node.lhs);
      return;
    case NodeKind.Return:
      addType(node.lhs);
      return;
    case NodeKind.If:
      addType(node.cond);
      addType(node.then);
      addType(node.els);
      return;
    case NodeKind.For:
      addType(node.init);
      addType(node.cond);
      addType(node.inc);
      addType(node.then);
      return;
    case NodeKind.Block:
      for (let n = node.body; n; n = n.next) addType(n);
      return;
    case NodeKind.NullExpr:
      node.ty = tyVoid;
      return;
    default:
      return;
  }
}

export { newCast };
