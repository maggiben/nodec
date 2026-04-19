#ifndef NODEC_STDIO_H
#define NODEC_STDIO_H

#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2

int printf(const char *fmt, ...);
int sprintf(char *buf, const char *fmt, ...);
int scanf(const char *fmt, ...);

/*
 * Opaque stream handles (host-backed). Use void * where ISO C uses FILE *.
 */
void *fopen(const char *path, const char *mode);
int fclose(void *stream);
unsigned long fread(void *ptr, unsigned long size, unsigned long nmemb, void *stream);
unsigned long fwrite(const void *ptr, unsigned long size, unsigned long nmemb, void *stream);
long ftell(void *stream);
int fseek(void *stream, long offset, int whence);
int fflush(void *stream);

#endif
