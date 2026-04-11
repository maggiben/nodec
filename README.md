# nodec

**nodec** is a C11-oriented compiler implemented in TypeScript. It tokenizes and preprocesses C source, parses it into an internal representation, and emits JavaScript that runs on **Node.js** inside a fresh `vm` context against a **linear memory** model (similar in spirit to Wasm or embedded C, not native code).

Use it to experiment with a small C toolchain in JavaScript, run portable C snippets without a native compiler, or inspect the generated JS for learning and debugging.

## Requirements

- **Node.js** ≥ 18

## Install and build

```bash
npm install
npm run build
```

The CLI entry point is `dist/cli.js`. From the repo root you can run it with `node dist/cli.js`, or use the npm script:

```bash
npm run hello   # build + run examples/hello.c
```

To use the `nodec` command globally after linking (optional):

```bash
npm link   # from this directory; then `nodec run file.c`
```

## Command-line usage

```text
nodec run <file.c>       Compile and run; program output goes to stdout via the host `log` hook (see below).
nodec emit-js <file.c>   Print the generated JavaScript to stdout (no execution).
```

Examples:

```bash
node dist/cli.js run examples/dice.c
node dist/cli.js emit-js examples/numbers.c > out.js
```

The process **exit code** is the integer returned from `main()` (as in a normal C program).

### What “running” means

- Generated code executes in **`node:vm`** with a **120 second** timeout.
- **Standard I/O is not a real POSIX stream**: `printf` / `sprintf` are implemented by the runtime and formatted output is delivered to a host callback (`console.log` in the CLI).
- **`sleep`** blocks the VM thread using `Atomics.wait` (see runtime notes below).

## How compilation works (overview)

1. **Tokenize** — Source files are turned into a token stream (identifiers, literals, punctuation, etc.).
2. **Preprocess** — `#include`, include guards, `#pragma once`, object-like `#define` / `#undef`, and macro expansion (with a simplified hideset). A predefined macro **`__nodec__`** is always defined (empty replacement).
3. **Parse** — C syntax is parsed into an AST / symbol structure aligned with a C11-style frontend.
4. **Layout** — Globals and string literals are placed in a **1 MiB** byte array; a **bump-allocated heap** starts after that region.
5. **Codegen** — JavaScript is emitted as an IIFE `function(__rt) { ... }` that returns an object of `fn_<name>` functions. Pointers are **bigint** addresses into the shared `Uint8Array`; loads/stores go through `__rt.load` / `__rt.store`.

For a deeper walkthrough of modules and data flow, see **[docs/architecture.md](docs/architecture.md)**.

## Include paths

When compiling `path/to/file.c`, headers are resolved in this order:

1. **`include/`** next to the installed `dist/` output (bundled stubs: `stdio.h`, `stdlib.h`, `unistd.h`).
2. **The source file’s directory** (for `#include "local.h"`).
3. **`include/`** at the repo root (handy when developing from source).

You can pass custom include paths if you use the **programmatic API** (see below).

## Bundled headers and libc-style runtime

The `include/` directory provides minimal declarations. Implementations live in the **Node.js runtime** (`src/runtime.ts`), not in separate C objects.

| Declared in | Behavior |
|-------------|----------|
| `printf` | Subset of `printf`; see [printf format specifiers](#printf-format-specifiers). Output is sent to the host `log` hook. |
| `sprintf` | Writes formatted UTF-8 bytes plus a NUL terminator into your buffer; returns length excluding NUL (or `0` on error). |
| `malloc` | Bump pointer allocator; pointers are stable for the lifetime of one VM run. |
| `free` | No-op (heap is not reused in-process). |
| `srand` / `rand` | POSIX-style PRNG state (LCG-style). |
| `time` | Seconds since Unix epoch; optional pointer argument writes **unsigned 64-bit LE** to memory. |
| `sleep` | Sleeps the given whole seconds via `Atomics.wait` (same thread as the VM). |

Other functions **declared** in your C code but not specially recognized are emitted as `__rt.call("name", [...])`, which logs an “unimplemented host call” line and returns `0`.

### `printf` format specifiers

Supported conversions (others are echoed roughly as literal text):

| Specifier | Meaning |
|-----------|---------|
| `%d`, `%i` | Signed integer (argument as used by codegen). |
| `%u` | 32-bit value printed as **unsigned** (`BigInt.asUintN(32, …)`). |
| `%c` | Character (low 8 bits). |
| `%s` | C string from memory (NUL-terminated). |
| `%f`, `%F` | Floating point, **fixed 6** digits after the decimal (matches common C default for `%f`). |
| `%%` | Literal `%`. |

## Programmatic API

The compiler driver is **`src/compile.ts`** (published as **`dist/compile.js`** after build).

```ts
import {
  compileFile,
  compileSource,
  runCompiled,
  defaultIncludePaths,
} from "./dist/compile.js";

// Compile a file on disk → { source, layout }
const { source, layout } = compileFile("/path/to/app.c");

// Compile arbitrary source (e.g. string from UI)
const again = compileSource("inline.c", cSource, defaultIncludePaths("/tmp/inline.c"));

// Run with custom logging
const { exitCode } = runCompiled("/path/to/app.c", {
  log: (line) => process.stdout.write(line),
});
```

- **`layout`** contains the initial **`memory`** `Uint8Array`, **`heapBase`**, and maps for globals / string literals—useful if you want to inspect rodata or build your own harness around the emitted JS.
- **`runCompiled`** loads the generated script with `runInVm` and invokes **`fn_main`** (your `main`).

## Examples in this repo

| File | Demonstrates |
|------|----------------|
| `examples/minimal.c` | Empty `main`, forward-declared `printf`. |
| `examples/hello.c` | Macros, `malloc` / `sprintf` / `printf` / `free`, `while`, `break`, `sleep`. |
| `examples/dice.c` | `time`, `srand`, `rand`, loops, formatted output. |
| `examples/numbers.c` | `double` and `%f`. |
| `examples/pointers_structs.c` | Pointers, structs, `->`, nested members, heap arrays; includes practical notes in comments. |

Run any of them with:

```bash
node dist/cli.js run examples/<name>.c
```

## Practical limits (JavaScript backend)

The frontend is built around C11 ideas, but the **JS backend intentionally supports a subset** suitable for demos and small programs.

**Generally well supported**

- Integer and floating scalar types used in examples, arithmetic, comparisons, casts.
- Control flow: `if` / `else`, `for` (including C-style three-part and `while`-like forms), `while` (via `for`), `break`, `continue`, `return`.
- Functions you define in the same translation unit; indirect calls are not the focus of the bundled runtime.
- Pointers: address-of globals/strings, `*p`, `p + n` / `p - n` with correct scaling, `->` and nested struct access through pointers, `malloc` buffers.
- `printf`, `sprintf`, and the builtins listed above.

**Caveats**

- **Structs on the stack**, **passing structs by value**, and **large stack arrays** can be limited or fragile; the `pointers_structs.c` comment recommends keeping structs on the **heap** via `malloc` for reliable behavior.
- **Heap**: single bump arena per run; **`free` does not recycle** memory.
- **Memory size**: fixed **1 MiB** linear memory; overrun returns `0` from `malloc`.
- **Statements / expressions** that parse but are **not lowered** in the current codegen may become no-ops or wrong values (e.g. unimplemented expression kinds may compile to `0n`; unsupported statements may emit placeholder comments). Prefer the constructs used in `examples/`.
- **No native object files or linking** of arbitrary `.o` libraries—only this compiler + runtime.

For component-level detail, see **[docs/architecture.md](docs/architecture.md)**.

## Project layout

```text
src/           TypeScript sources (tokenizer, preprocessor, parser, codegen, runtime, CLI)
dist/          Compiled JavaScript (`npm run build`)
include/       Minimal system headers for `#include <...>`
examples/      Sample C programs
```

## License MIT
