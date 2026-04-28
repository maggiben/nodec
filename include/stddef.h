#ifndef NODEC_STDDEF_H
#define NODEC_STDDEF_H

/* Minimal stddef for nodec. */

typedef unsigned long size_t;
typedef long ptrdiff_t;

#ifndef NULL
#define NULL ((void *) 0)
#endif

#define offsetof(type, member) ((size_t) &(((type *) 0)->member))

#endif

