#include "../mjs/mjs.c"

static int run_file(const char *path) {
  struct mjs *m = mjs_create();
  if (m == 0) return 0;
  size_t sz = 0;
  char *src = cs_read_file(path, &sz);
  if (src == NULL) {
    printf("read fail %s\n", path);
    mjs_destroy(m);
    return 0;
  }
  mjs_val_t res = MJS_UNDEFINED;
  mjs_err_t err = mjs_exec(m, src, &res);
  free(src);
  if (err != MJS_OK) {
    mjs_print_error(m, stdout, path, 1);
    printf("exec error in %s err=%d %s\n", path, (int) err, mjs_strerror(m, err));
    mjs_destroy(m);
    return 0;
  }
  int ok = 1;
  printf("test %s => PASS\n", path);
  mjs_destroy(m);
  return ok;
}

int main() {
  int ok = 1;
  if (!run_file("mjs/tests/test_1.js")) ok = 0;
  if (!run_file("mjs/tests/test_2.js")) ok = 0;
  if (!run_file("mjs/tests/test_3.js")) ok = 0;
  if (!run_file("mjs/tests/test_4.js")) ok = 0;
  if (!run_file("mjs/tests/test_5.js")) ok = 0;
  if (!run_file("mjs/tests/test_6.js")) ok = 0;
  if (!run_file("mjs/tests/test_7.js")) ok = 0;
  if (!run_file("mjs/tests/test_8.js")) ok = 0;
  if (!run_file("mjs/tests/test_9.js")) ok = 0;
  if (!run_file("mjs/tests/test_10.js")) ok = 0;
  if (!run_file("mjs/tests/test_11.js")) ok = 0;
  if (!run_file("mjs/tests/test_12.js")) ok = 0;
  if (!run_file("mjs/tests/test_13.js")) ok = 0;

  printf("mjs tests subset: %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 2;
}

