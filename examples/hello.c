#define TRUE 1
#define FALSE 0
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

char *greet(char *msg) {
  char *buf = (char *)malloc(128);
  if (buf == (char *)0) {
    return (char *)0;
  }
  sprintf(buf, "Hello, %s\n", msg);
  return buf;
}

int main() {
  char *s = greet("World");
  if (s != (char *)0) {
    printf("%s", s);
    free(s);
  }
  int i = 0;
  while (TRUE) {
    printf("Number: %d\n", i);
    sleep(1);
    i = i + 1;
    if (i > 100) {
      break;
    }
  }
  return 0;
}
