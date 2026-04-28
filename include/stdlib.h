#ifndef NODEC_STDLIB_H
#define NODEC_STDLIB_H

void *malloc(unsigned long size);
void *realloc(void *ptr, unsigned long size);
void *calloc(unsigned long nmemb, unsigned long size);
void free(void *ptr);
void abort(void);
void exit(int status);
long strtol(const char *nptr, char **endptr, int base);
unsigned long strtoul(const char *nptr, char **endptr, int base);
double strtod(const char *nptr, char **endptr);
int atoi(const char *nptr);
long atol(const char *nptr);
double atof(const char *nptr);

void srand(unsigned int seed);
int rand(void);

unsigned long time(unsigned long *timer);

#endif
