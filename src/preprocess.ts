/**
 * Token preprocessor: #include, include guards, #pragma once,
 * object-like #define / #undef, and recursive macro expansion (simplified hideset).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Token } from "./ctypes.js";
import { TokenKind } from "./ctypes.js";
import { equal, tokenize, newFile, convertPpTokens } from "./tokenize.js";
import { errorTok } from "./diag.js";

export type IncludeContext = {
  /** Paths tried after the directory of the including file */
  includePaths: string[];
};

/** Deep-enough copy for macro expansion (detaches `next`, clones `str`). */
function copyTok(tok: Token): Token {
  return {
    ...tok,
    next: null,
    str: tok.str ? Uint8Array.from(tok.str) : null,
  };
}

/** Appends token chain `b` after a deep copy of `a` (excluding trailing Eof semantics). */
function appendTok(a: Token | null, b: Token | null): Token | null {
  if (!a || a.kind === TokenKind.Eof) return b;
  const head = copyTok(a);
  let cur = head;
  let x: Token | null = a.next;
  while (x && x.kind !== TokenKind.Eof) {
    cur.next = copyTok(x);
    cur = cur.next;
    x = x.next;
  }
  cur.next = b;
  return head;
}

/** Lexeme text of token `t`. */
function tokStr(t: Token): string {
  return t.file.contents.slice(t.loc, t.loc + t.len);
}

/** True if `t` is `#` at beginning of a logical line (directive start). */
function isHash(t: Token | null): boolean {
  return !!(t && t.atBol && equal(t, "#"));
}

/** Advances to the next line's first token (or Eof). */
function skipLine(t: Token | null): Token | null {
  if (!t) return t;
  while (t && t.kind !== TokenKind.Eof && !t.atBol) t = t.next;
  return t;
}

type MacroBody = { tokens: Token[]; params: string[] | null; variadic: boolean };

/** Handles `#` directives, conditional inclusion, and object-like macro expansion. */
export class Preprocessor {
  private macros = new Map<string, MacroBody>();
  private pragmaOnce = new Set<string>();
  private ctx: IncludeContext;

  /** @param ctx Include search path list used by `#include`. */
  constructor(ctx: IncludeContext) {
    this.ctx = ctx;
    this.initPredefined();
  }

  /** Defines compiler-identification macros. */
  private initPredefined(): void {
    this.macros.set("__nodec__", { tokens: [], params: null, variadic: false });
  }

  /** Registers an object-like macro (tests / tooling); body tokens are expanded later. */
  define(name: string, body: Token[]): void {
    this.macros.set(name, { tokens: body, params: null, variadic: false });
  }

  /** Removes a macro definition if present. */
  undef(name: string): void {
    this.macros.delete(name);
  }

  /** "quoted" include: same directory as including file, then -I paths. */
  searchQuoted(filename: string, includingDir: string): string | null {
    if (filename.startsWith("/")) return existsSync(filename) ? filename : null;
    const local = resolve(includingDir, filename);
    if (existsSync(local)) return local;
    for (const p of this.ctx.includePaths) {
      const full = resolve(p, filename);
      if (existsSync(full)) return full;
    }
    return null;
  }

  /** <system> include: only -I paths. */
  searchSystem(filename: string): string | null {
    if (filename.startsWith("/")) return existsSync(filename) ? filename : null;
    for (const p of this.ctx.includePaths) {
      const full = resolve(p, filename);
      if (existsSync(full)) return full;
    }
    return null;
  }

  /** Runs directive pass then macro expansion; returns a new token stream head. */
  process(head: Token | null): Token | null {
    return this.directives(head);
  }

  private cloneRange(start: Token, endExclusive: Token | null): Token | null {
    if (start === endExclusive) return null;
    const head = copyTok(start);
    let cur = head;
    let p = start.next;
    while (p && p !== endExclusive) {
      cur.next = copyTok(p);
      cur = cur.next;
      p = p.next;
    }
    cur.next = { ...copyTok(cur), kind: TokenKind.Eof, next: null, loc: 0, len: 0 };
    return head;
  }

  /** Strips/handlers for `#include`, `#define`, `#if`, etc.; emits non-directive tokens. */
  private directives(head: Token | null): Token | null {
    const outHead: Token = {
      kind: TokenKind.Eof,
      next: null,
      val: 0n,
      fval: 0,
      loc: 0,
      len: 0,
      ty: null,
      str: null,
      file: head?.file!,
      filename: "",
      lineNo: 1,
      lineDelta: 0,
      atBol: false,
      hasSpace: false,
    };
    let cur = outHead;
    let condStack: { skip: boolean; branchTaken: boolean }[] = [];

    const skipping = () => condStack.some((c) => c.skip);
    const emitChain = (t: Token | null) => {
      let p = t;
      while (p && p.kind !== TokenKind.Eof) {
        cur.next = copyTok(p);
        cur = cur.next;
        p = p.next;
      }
    };

    let tok = head;
    while (tok && tok.kind !== TokenKind.Eof) {
      if (isHash(tok)) {
        const dir = tok.next;
        if (!dir) break;
        const name = dir.kind === TokenKind.Ident || dir.kind === TokenKind.Keyword ? tokStr(dir) : "";

        if (name === "include") {
          if (skipping()) {
            tok = skipLine(dir.next);
            continue;
          }
          let p = dir.next;
          while (p && !p.atBol && p.kind !== TokenKind.Eof) p = p.next;
          const pathTok = dir.next;
          if (!pathTok) errorTok(dir, "expected include path");
          let path = "";
          let incPath: string | null = null;
          if (equal(pathTok, "<")) {
            let q = pathTok.next;
            while (q && !equal(q, ">")) {
              path += tokStr(q);
              q = q.next;
            }
            if (!q || !equal(q, ">")) errorTok(pathTok, "expected '>'");
            tok = skipLine(q.next);
            incPath = this.searchSystem(path);
          } else if (pathTok.kind === TokenKind.Str && pathTok.str) {
            path = new TextDecoder().decode(pathTok.str);
            tok = skipLine(pathTok.next);
            incPath = this.searchQuoted(path, dirname(dir.file.name));
          } else errorTok(pathTok, "expected string or <...> include");

          if (!incPath) errorTok(dir, "include file not found: %s", path);

          if (this.pragmaOnce.has(incPath)) continue;

          let inner = readFileSync(incPath, "utf8");
          if (inner.startsWith("\ufeff")) inner = inner.slice(1);
          const file = newFile(incPath, dir.file.fileNo + 1000, inner);
          let incTok: Token | null = tokenize(file);
          incTok = this.directives(incTok);
          emitChain(incTok);
          continue;
        }

        if (name === "define") {
          if (skipping()) {
            tok = skipLine(dir.next);
            continue;
          }
          let p = dir.next;
          if (!p || p.kind !== TokenKind.Ident) errorTok(dir, "expected macro name");
          const mname = tokStr(p);
          p = p.next;
          const body: Token[] = [];
          let params: string[] | null = null;
          let variadic = false;
          // Function-like macro: NAME(...). The invocation form is only when '(' is not
          // separated from the macro name by whitespace.
          if (p && equal(p, "(") && !p.hasSpace) {
            params = [];
            p = p.next;
            if (!p) errorTok(dir, "unterminated macro parameter list");
            if (p && equal(p, ")")) {
              // Zero-arg macro.
              p = p.next;
            } else {
              while (p && !p.atBol && p.kind !== TokenKind.Eof) {
                if (equal(p, "...")) {
                  variadic = true;
                  params.push("__VA_ARGS__");
                  p = p.next;
                  if (!p || !equal(p, ")")) errorTok(dir, "expected ')' after ...");
                  p = p.next;
                  break;
                }
                if (p.kind !== TokenKind.Ident) errorTok(p, "expected macro parameter name");
                params.push(tokStr(p));
                p = p.next;
                if (!p) errorTok(dir, "unterminated macro parameter list");
                if (equal(p, ")")) {
                  p = p.next;
                  break;
                }
                if (!equal(p, ",")) errorTok(p, "expected ',' or ')' in macro parameter list");
                p = p.next;
              }
            }
          }
          while (p && !p.atBol && p.kind !== TokenKind.Eof) {
            body.push(copyTok(p));
            p = p.next;
          }
          this.macros.set(mname, { tokens: body, params, variadic });
          tok = p;
          continue;
        }

        if (name === "undef") {
          if (skipping()) {
            tok = skipLine(dir.next);
            continue;
          }
          const n = dir.next;
          if (!n || n.kind !== TokenKind.Ident) errorTok(dir, "expected macro name");
          this.macros.delete(tokStr(n));
          tok = skipLine(n.next);
          continue;
        }

        if (name === "ifdef" || name === "ifndef") {
          const n = dir.next;
          if (!n || n.kind !== TokenKind.Ident) errorTok(dir, "expected identifier");
          const defined = this.macros.has(tokStr(n));
          const take = name === "ifdef" ? defined : !defined;
          condStack.push({ skip: !take, branchTaken: take });
          tok = skipLine(n.next);
          continue;
        }

        if (name === "else") {
          if (condStack.length === 0) errorTok(dir, "stray #else");
          const c = condStack[condStack.length - 1]!;
          if (!c.branchTaken) {
            c.skip = false;
            c.branchTaken = true;
          } else c.skip = true;
          tok = skipLine(dir.next);
          continue;
        }

        if (name === "endif") {
          if (condStack.length === 0) errorTok(dir, "stray #endif");
          condStack.pop();
          tok = skipLine(dir.next);
          continue;
        }

        if (name === "pragma") {
          let p = dir.next;
          if (!skipping() && p && p.kind === TokenKind.Ident && tokStr(p) === "once") {
            this.pragmaOnce.add(dir.file.name);
          }
          tok = skipLine(dir.next);
          continue;
        }

        if (name === "if" || name === "elif") {
          if (name === "elif") {
            if (condStack.length === 0) errorTok(dir, "stray #elif");
            const c = condStack[condStack.length - 1]!;
            if (c.branchTaken) {
              c.skip = true;
              tok = skipLine(dir.next);
              continue;
            }
          }
          if (skipping() && name === "if") {
            condStack.push({ skip: true, branchTaken: false });
            tok = skipLine(dir.next);
            continue;
          }
          const taken = this.evalIfLine(dir.next);
          if (name === "if") condStack.push({ skip: !taken, branchTaken: taken });
          else {
            const c = condStack[condStack.length - 1]!;
            c.skip = !taken;
            c.branchTaken = taken;
          }
          tok = skipLine(this.skipIfExpr(dir.next));
          continue;
        }

        tok = skipLine(dir.next);
        continue;
      }

      if (skipping()) {
        tok = tok.next;
        continue;
      }

      // Expand non-directive token runs immediately so macro redefinitions
      // later in the file do not retroactively affect earlier code.
      const segStart = tok;
      let segEnd: Token | null = tok;
      while (segEnd && segEnd.kind !== TokenKind.Eof && !isHash(segEnd)) segEnd = segEnd.next;
      const seg = this.cloneRange(segStart, segEnd);
      const expanded = this.expand(seg);
      emitChain(expanded);
      tok = segEnd;
    }

    cur.next = {
      kind: TokenKind.Eof,
      next: null,
      val: 0n,
      fval: 0,
      loc: 0,
      len: 0,
      ty: null,
      str: null,
      file: head?.file!,
      filename: "",
      lineNo: 1,
      lineDelta: 0,
      atBol: false,
      hasSpace: false,
    };
    return outHead.next;
  }

  /** Skips tokens until start of next line (after `#if` / `#elif` expression). */
  private skipIfExpr(start: Token | null): Token | null {
    let p = start;
    while (p && !p.atBol && p.kind !== TokenKind.Eof) p = p.next;
    return p;
  }

  /** Minimal #if constant expression: numbers, defined(X), && || ! ( ) */
  private evalIfLine(start: Token | null): boolean {
    const toks: Token[] = [];
    let p = start;
    while (p && !p.atBol && p.kind !== TokenKind.Eof) {
      toks.push(p);
      p = p.next;
    }
    let i = 0;
    const peek = () => toks[i] ?? null;
    const eat = () => toks[i++];

    const parsePrimary = (): boolean => {
      const t = peek();
      if (!t) return false;
      if (equal(t, "(")) {
        eat();
        const v = parseOr();
        if (!peek() || !equal(peek()!, ")")) return false;
        eat();
        return v;
      }
      if (t.kind === TokenKind.Num) {
        eat();
        return t.val !== 0n;
      }
      if (t.kind === TokenKind.Ident && tokStr(t) === "defined") {
        eat();
        let needClose = false;
        if (peek() && equal(peek()!, "(")) {
          needClose = true;
          eat();
        }
        const n = peek();
        if (!n || n.kind !== TokenKind.Ident) return false;
        eat();
        const def = this.macros.has(tokStr(n));
        if (needClose && (!peek() || !equal(peek()!, ")"))) return false;
        if (needClose) eat();
        return def;
      }
      eat();
      return false;
    };

    const parseUnary = (): boolean => {
      const t = peek();
      if (t && equal(t, "!")) {
        eat();
        return !parseUnary();
      }
      return parsePrimary();
    };

    const parseAnd = (): boolean => {
      let v = parseUnary();
      while (peek() && equal(peek()!, "&&")) {
        eat();
        v = v && parseUnary();
      }
      return v;
    };

    const parseOr = (): boolean => {
      let v = parseAnd();
      while (peek() && equal(peek()!, "||")) {
        eat();
        v = v || parseAnd();
      }
      return v;
    };

    return parseOr();
  }

  private captureMacroArgs(
    openParen: Token,
    params: string[],
    variadic: boolean
  ): { args: Token[][]; endTok: Token | null; vaTokens: Token[] | null } {
    // openParen is the '(' token, parse until its matching ')'.
    let t = openParen.next;
    if (!t) errorTok(openParen, "unterminated macro invocation");

    const args: Token[][] = [];
    let cur: Token[] = [];
    let depth = 0;
    // Special-case empty argument list: NAME()
    if (t && equal(t, ")")) return { args: [], endTok: t.next, vaTokens: variadic ? [] : null };

    while (t && t.kind !== TokenKind.Eof) {
      if (equal(t, "(")) {
        depth++;
        cur.push(copyTok(t));
        t = t.next;
        continue;
      }
      if (equal(t, ")")) {
        if (depth === 0) {
          args.push(cur);
          t = t.next;
          break;
        }
        depth--;
        cur.push(copyTok(t));
        t = t.next;
        continue;
      }
      if (equal(t, ",") && depth === 0) {
        args.push(cur);
        cur = [];
        t = t.next;
        continue;
      }
      cur.push(copyTok(t));
      t = t.next;
    }

    const expected = variadic ? Math.max(0, params.length - 1) : params.length;
    if (!variadic && args.length !== expected) {
      errorTok(openParen, "macro argument count mismatch: expected %d, got %d", expected, args.length);
    }
    if (variadic && args.length < expected) {
      errorTok(openParen, "macro argument count mismatch: expected at least %d, got %d", expected, args.length);
    }

    let vaTokens: Token[] | null = null;
    if (variadic) {
      const fixedCount = Math.max(0, params.length - 1);
      // Re-scan the invocation to capture tokens (including commas) for the variadic tail.
      vaTokens = [];
      let argIndex = 0;
      let depth2 = 0;
      let u: Token | null = openParen.next;
      if (u && equal(u, ")")) {
        // nothing
      } else {
        while (u && u.kind !== TokenKind.Eof) {
          if (equal(u, "(")) depth2++;
          else if (equal(u, ")")) {
            if (depth2 === 0) break;
            depth2--;
          } else if (equal(u, ",") && depth2 === 0) {
            argIndex++;
            if (argIndex >= fixedCount) vaTokens.push(copyTok(u));
            u = u.next;
            continue;
          }
          if (argIndex >= fixedCount) vaTokens.push(copyTok(u));
          u = u.next;
        }
      }
    }

    return { args, endTok: t, vaTokens };
  }

  private substituteMacroBody(
    body: Token[],
    params: string[],
    variadic: boolean,
    args: Token[][],
    vaTokens: Token[] | null
  ): Token[] {
    const byName = new Map<string, Token[]>();
    const fixedCount = variadic ? Math.max(0, params.length - 1) : params.length;
    for (let i = 0; i < fixedCount; i++) byName.set(params[i]!, args[i] ?? []);
    if (variadic) {
      byName.set("__VA_ARGS__", vaTokens ?? []);
    }

    const out: Token[] = [];
    for (const t of body) {
      if (t.kind === TokenKind.Ident) {
        const repl = byName.get(tokStr(t));
        if (repl) {
          for (const rt of repl) out.push(copyTok(rt));
          continue;
        }
      }
      out.push(copyTok(t));
    }
    return out;
  }

  /** Expands macros on a linear token stream (hideset prevents infinite recursion). */
  private expand(head: Token | null): Token | null {
    return this.expandWithHide(head, new Set());
  }

  private expandWithHide(head: Token | null, hide: Set<string>): Token | null {
    const h: Token = {
      kind: TokenKind.Eof,
      next: null,
      val: 0n,
      fval: 0,
      loc: 0,
      len: 0,
      ty: null,
      str: null,
      file: head?.file!,
      filename: "",
      lineNo: 1,
      lineDelta: 0,
      atBol: false,
      hasSpace: false,
    };
    let cur = h;
    let tok = head;
    while (tok && tok.kind !== TokenKind.Eof) {
      if (tok.kind === TokenKind.Ident) {
        const name = tokStr(tok);
        if (hide.has(name)) {
          cur.next = copyTok(tok);
          cur = cur.next;
          tok = tok.next;
          continue;
        }
        const m = this.macros.get(name);
        if (m) {
          // Function-like: NAME(...)
          if (m.params !== null) {
            // Accept invocation with immediate '(' token next.
            const nxt = tok.next;
            if (!nxt || !equal(nxt, "(")) {
              // Not an invocation; leave as-is.
              cur.next = copyTok(tok);
              cur = cur.next;
              tok = tok.next;
              continue;
            }
            const { args, endTok, vaTokens } = this.captureMacroArgs(nxt, m.params, m.variadic);
            const substituted = this.substituteMacroBody(m.tokens, m.params, m.variadic, args, vaTokens);
            const nh = new Set(hide);
            nh.add(name);
            const expanded = this.expandList(substituted, nh);
            let e = expanded;
            while (e) {
              cur.next = e;
              cur = e;
              e = e.next!;
            }
            tok = endTok;
            continue;
          }
          // Object-like.
          const nh = new Set(hide);
          nh.add(name);
          const expanded = this.expandList(m.tokens, nh);
          let e = expanded;
          while (e) {
            cur.next = e;
            cur = e;
            e = e.next!;
          }
          tok = tok.next;
          continue;
        }
      }
      cur.next = copyTok(tok);
      cur = cur.next;
      tok = tok.next;
    }
    cur.next = {
      kind: TokenKind.Eof,
      next: null,
      val: 0n,
      fval: 0,
      loc: 0,
      len: 0,
      ty: null,
      str: null,
      file: head?.file!,
      filename: "",
      lineNo: 1,
      lineDelta: 0,
      atBol: false,
      hasSpace: false,
    };
    return h.next;
  }

  /** Expands a macro body token list while `hide` blocks re-expansion of active macro names. */
  private expandList(tokens: Token[], hide: Set<string>): Token | null {
    // Build a temporary linear stream and reuse the main expander.
    if (tokens.length === 0) return null;
    const head = copyTok(tokens[0]!);
    let cur = head;
    for (let i = 1; i < tokens.length; i++) {
      cur.next = copyTok(tokens[i]!);
      cur = cur.next;
    }
    cur.next = { ...copyTok(tokens[tokens.length - 1]!), kind: TokenKind.Eof, next: null, len: 0, loc: 0 };
    const expanded = this.expandWithHide(head, hide);
    if (!expanded) return null;
    // Macro-body expansion should return a plain token chain (no EOF sentinel),
    // otherwise callers may splice an early EOF into the middle of a stream.
    if (expanded.kind === TokenKind.Eof) return null;
    let p: Token = expanded;
    while (p.next && p.next.kind !== TokenKind.Eof) p = p.next;
    if (p.next && p.next.kind === TokenKind.Eof) p.next = null;
    return expanded;
  }
}

/**
 * Full preprocessor pipeline: directives, includes, macros, then {@link convertPpTokens}.
 * @param tok Token stream from {@link tokenize}.
 */
export function preprocess(tok: Token | null, ctx: IncludeContext): Token | null {
  const pp = new Preprocessor(ctx);
  const out = pp.process(tok);
  convertPpTokens(out);
  return out;
}
