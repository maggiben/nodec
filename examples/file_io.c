/*
 * Minimal stdio file I/O (fopen / fwrite / fread / fclose / ftell / fseek).
 *
 * Run from repo root: node dist/cli.js run examples/file_io.c
 * Writes a scratch file under examples/ (gitignored name).
 */
#include <stdio.h>
#include <stdlib.h>

#define SCRATCH "examples/.nodec_file_io_scratch.txt"

int main(void) {
  void *f;
  unsigned char *buf;
  unsigned long n;
  long pos;

  f = fopen(SCRATCH, "w");
  if (f == (void *)0) {
    printf("fopen w failed\n");
    return 1;
  }
  if (fwrite("nodec\n", 1, 6, f) != 6UL) {
    printf("fwrite failed\n");
    fclose(f);
    return 2;
  }
  if (fclose(f) != 0) {
    printf("fclose failed\n");
    return 3;
  }

  f = fopen(SCRATCH, "r");
  if (f == (void *)0) {
    printf("fopen r failed\n");
    return 4;
  }
  pos = ftell(f);
  printf("ftell after open: %d\n", (int)pos);
  if (fseek(f, 0, SEEK_END) != 0) {
    printf("fseek end failed\n");
    fclose(f);
    return 5;
  }
  pos = ftell(f);
  printf("len: %d\n", (int)pos);
  if (fseek(f, 0, SEEK_SET) != 0) {
    printf("fseek set failed\n");
    fclose(f);
    return 6;
  }
  buf = (unsigned char *)malloc((unsigned long)64);
  if (buf == (unsigned char *)0) {
    printf("malloc buf failed\n");
    fclose(f);
    return 8;
  }
  n = fread(buf, 1, 63, f);
  buf[n] = 0;
  if (fclose(f) != 0) {
    printf("fclose 2 failed\n");
    free((void *)buf);
    return 7;
  }
  printf("n=%d\n", (int)n);
  free((void *)buf);
  return 0;
}
