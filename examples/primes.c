#define TRUE 1
#define FALSE 0
#include <stdio.h>
#include <unistd.h>

int is_prime(int n) {
  int d;
  if (n < 2) {
    return FALSE;
  }
  if (n == 2) {
    return TRUE;
  }
  if (n % 2 == 0) {
    return FALSE;
  }
  d = 3;
  while (d <= n / d) {
    if (n % d == 0) {
      return FALSE;
    }
    d = d + 2;
  }
  return TRUE;
}

int main() {
  int n;
  printf("Enter the initial number: ");
  scanf("%d", &n);
  for (;;) {
    if (is_prime(n)) {
      printf("%d\n", n);
      sleep(0.1);
    }
    n = n + 1;
  }
  return 0;
}
