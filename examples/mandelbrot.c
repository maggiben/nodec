/*
 * ASCII Mandelbrot set — terminal-style shading (digits + punctuation),
 * aspect corrected for tall characters (~2:1 height:width).
 *
 * Iteration is inlined in main(): the JS backend passes function args as
 * BigInt, so user functions cannot take non-integer doubles.
 *
 * Run: node dist/cli.js run examples/mandelbrot.c
 */
#include <stdio.h>
#include <stdlib.h>

#define WIDTH 80
#define HEIGHT 25
#define MAX_ITER 120

int main() {
  double xd;
  double yd;
  double xmin;
  double xmax;
  double ymin;
  double ymax;
  double xspan;
  double yspan;
  double cr;
  double ci;
  double zr;
  double zi;
  double zr2;
  double zi2;
  double nzr;
  int iter;
  int shade;
  int ramp_len;
  char *ramp;
  char *row;
  char *p;

  /*
   * Outside → inside (low escape count → high). Interior uses 0 / 8 like
   * classic terminal Mandelbrot; fringe uses . , - _ : ; then digits and b.
   */
  ramp = " .,-_:;'`+!i169378b800008888008888000";
  ramp_len = 37;

  xmin = -2.35;
  xmax = 0.65;
  /* Tall glyphs: keep imag span narrower so the set is not squashed vertically */
  ymin = -1.0;
  ymax = 1.0;
  xspan = xmax - xmin;
  yspan = ymax - ymin;

  printf("Mandelbrot set (%dx%d, max iter %d)", WIDTH, HEIGHT, MAX_ITER);

  row = (char *)malloc((unsigned long)(WIDTH + 4));
  if (row == (char *)0) {
    printf("malloc failed\n");
    return 1;
  }

  yd = 0.0;
  while (yd < 25.0) {
    p = row;
    xd = 0.0;
    while (xd < 80.0) {
      cr = xmin + xspan * xd / 79.0;
      ci = ymax - yspan * yd / 24.0;
      zr = 0.0;
      zi = 0.0;
      iter = 0;
      while (iter < MAX_ITER) {
        zr2 = zr * zr;
        zi2 = zi * zi;
        if (zr2 + zi2 > 4.0) {
          break;
        }
        nzr = zr2 - zi2 + cr;
        zi = 2.0 * zr * zi + ci;
        zr = nzr;
        iter = iter + 1;
      }
      shade = (iter * (ramp_len - 1)) / MAX_ITER;
      if (shade > ramp_len - 1) {
        shade = ramp_len - 1;
      }
      *p = ramp[shade];
      p = p + 1;
      xd = xd + 1.0;
    }
    *p = 0;
    /* One printf per row: host log adds a newline; do not embed \n in the format. */
    printf("%s", row);
    yd = yd + 1.0;
  }

  free((void *)row);
  return 0;
}
