#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main() {
  int i;
  int roll;

  srand((unsigned int)time((unsigned long *)0));

  printf("Rolling a 6-sided die 5 times:\n");
  i = 0;
  while (i < 5) {
    roll = (int)(rand() % 6) + 1;
    printf("  throw %d: %d\n", i + 1, roll);
    sleep(1);
    i = i + 1;
  }

  return 0;
}
