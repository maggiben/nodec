/*
 * Deliberately read a 32-bit int from an address where the final byte would
 * fall past the end of nodec's 1 MiB linear memory. The runtime uses
 * DataView.getInt32, which throws RangeError (surfaced as an uncaught
 * exception when you `nodec run` this file).
 *
 * Valid byte indices are 0 .. 1048575. An int32 at 1048573 touches index
 * 1048576, which is out of range.
 */
#include <stdio.h>

#define MEM_SIZE ((unsigned long)(1024UL * 1024UL))
#define BAD_INT_ADDR (MEM_SIZE - 3UL)

int main(void) {
  int *p = (int *)BAD_INT_ADDR;
  printf("about to load int past end of linear memory\n");
  return *p;
}
