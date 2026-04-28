#include "../mjs/mjs.c"

int main() {
  struct mjs *m = mjs_create();
  if (m == 0) {
    printf("mjs_create failed\n");
    return 1;
  }

  mjs_err_t err = mjs_exec(m, "1 + 2 * 3", 0);
  if (err != MJS_OK) {
    mjs_print_error(m, stdout, "mjs error", 1);
    mjs_destroy(m);
    return 2;
  }

  printf("mjs embedded ok\n");
  mjs_destroy(m);
  return 0;
}

