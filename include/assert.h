#ifndef NODEC_ASSERT_H
#define NODEC_ASSERT_H

/* Minimal assert for nodec: disabled by default. */

#ifndef NDEBUG
#define assert(expr) ((void) 0)
#else
#define assert(expr) ((void) 0)
#endif

#endif

