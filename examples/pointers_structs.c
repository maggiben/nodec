/*
 * pointers, structs, and scalar types
 * (int, unsigned short, unsigned char, char *).
 *
 * Heap objects + -> (and nested e->pos.x) are lowered correctly.
 * Struct locals, passing struct by value, and stack arrays are still
 * limited in the JS backend — keep structs on the heap via malloc.
 */
#include <stdio.h>
#include <stdlib.h>

struct Point {
  int x;
  int y;
};

struct Entity {
  char *label;
  unsigned short kind;
  unsigned char flags;
  struct Point pos;
};

void bump_point(struct Point *p, int dx, int dy) {
  p->x = p->x + dx;
  p->y = p->y + dy;
}

void print_entity(struct Entity *e) {
  printf("entity: label=%s kind=%d flags=%d pos=(%d,%d)\n",
      e->label, (int)e->kind, (int)e->flags, e->pos.x, e->pos.y);
}

unsigned int point_len_sq(struct Point *p) {
  return (unsigned int)(p->x * p->x + p->y * p->y);
}

int main() {
  struct Point *a = (struct Point *)malloc((unsigned long)sizeof(struct Point));
  if (a == (struct Point *)0) {
    printf("malloc Point failed\n");
    return 1;
  }
  a->x = 3;
  a->y = 4;
  printf("sizeof(struct Point) = %d\n", (int)sizeof(struct Point));
  printf("len_sq(heap point) = %u\n", point_len_sq(a));

  bump_point(a, 10, -1);
  printf("after bump_point: a=(%d,%d)\n", a->x, a->y);

  struct Entity *e = (struct Entity *)malloc((unsigned long)sizeof(struct Entity));
  if (e == (struct Entity *)0) {
    printf("malloc Entity failed\n");
    return 1;
  }

  e->label = "demo";
  e->kind = 42;
  e->flags = 255;
  e->pos.x = -5;
  e->pos.y = 7;

  print_entity(e);

  /* int block: pointer + offset (scaled by sizeof(int) in codegen) */
  int *nums = (int *)malloc((unsigned long)(4 * (unsigned long)sizeof(int)));
  if (nums == (int *)0) {
    printf("malloc nums failed\n");
    return 1;
  }
  *nums = 100;
  *(nums + 1) = 200;
  *(nums + 2) = 300;
  *(nums + 3) = 400;
  printf("ints via pointer: %d %d %d %d\n", *nums, *(nums + 1), *(nums + 2), *(nums + 3));

  free((void *)a);
  free((void *)e);
  free((void *)nums);
  return 0;
}
