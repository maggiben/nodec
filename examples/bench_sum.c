/*
 * Micro-benchmark: fill a malloc buffer and sum bytes (hot path is load/store + int loops).
 * Used by scripts/bench-vs-js.mjs to compare against hand-written JavaScript on the same V8.
 */
#include <stdlib.h>

/* Must fit in nodec's 1 MiB linear memory (heap shares the buffer with globals/rodata). */
#define N 1000000

int main(void) {
  char *p;
  int i;
  int sum;

  p = (char *)malloc((unsigned long)N);
  if (p == (char *)0) {
    return 1;
  }
  for (i = 0; i < N; i = i + 1) {
    *(p + i) = (char)(i % 256);
  }
  sum = 0;
  for (i = 0; i < N; i = i + 1) {
    sum = sum + (int)*(p + i);
  }
  free((void *)p);
  return sum % 251;
}
