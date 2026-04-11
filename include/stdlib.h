#ifndef NODEC_STDLIB_H
#define NODEC_STDLIB_H

void *malloc(unsigned long size);
void free(void *ptr);

void srand(unsigned int seed);
int rand(void);

unsigned long time(unsigned long *timer);

#endif
