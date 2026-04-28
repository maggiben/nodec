#ifndef NODEC_STDIO_H
#define NODEC_STDIO_H

#include <stddef.h>

#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2

/*
 * nodec does not implement a real libc FILE. Treat FILE* as an opaque handle.
 * The runtime uses host-backed stream slots.
 */
typedef void FILE;
extern FILE *stdin;
extern FILE *stdout;
extern FILE *stderr;

int printf(const char *fmt, ...);
int fprintf(FILE *stream, const char *fmt, ...);
int sprintf(char *buf, const char *fmt, ...);
int snprintf(char *buf, size_t size, const char *fmt, ...);
int vsnprintf(char *buf, size_t size, const char *fmt, void *ap);
int scanf(const char *fmt, ...);
int sscanf(const char *str, const char *fmt, ...);
int fputc(int c, FILE *stream);
int fgetc(FILE *stream);
int putchar(int c);
int getchar(void);
int puts(const char *s);
int ferror(FILE *stream);
int feof(FILE *stream);

FILE *fopen(const char *path, const char *mode);
int fclose(FILE *stream);
size_t fread(void *ptr, size_t size, size_t nmemb, FILE *stream);
size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream);
long ftell(FILE *stream);
int fseek(FILE *stream, long offset, int whence);
int fflush(FILE *stream);

#endif
