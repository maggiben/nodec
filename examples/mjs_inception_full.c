#include "../mjs/mjs.c"

int main() {
  struct mjs *m = mjs_create();
  if (m == 0) return 1;

  const char *script =
      "let arr = [1,2,3,4];"
      "arr.splice(1,2,9,8);"
      "let obj = {a: 1, b: 2};"
      "let k = 0;"
      "for (let n in obj) k += 1;"
      "let i = 'abcdef'.indexOf('cd');"
      "let s = 'abcdef'.slice(1, 4);"
      "if (!(arr[1] === 9 && arr[2] === 8 && k === 2 && i === 2 && s === 'bcd')) not_callable();";

  mjs_val_t res = MJS_UNDEFINED;
  mjs_err_t err = mjs_exec(m, script, &res);
  if (err != MJS_OK) {
    mjs_print_error(m, stdout, "inception", 1);
    printf("mjs inception full feature script: EXEC_ERROR\n");
    mjs_destroy(m);
    return 2;
  }

  int ok = 1;
  printf("mjs inception full feature script: %s\n", ok ? "PASS" : "FAIL");
  mjs_destroy(m);
  return ok ? 0 : 3;
}

