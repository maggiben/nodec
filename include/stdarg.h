#ifndef NODEC_STDARG_H
#define NODEC_STDARG_H

/*
 * Minimal stdarg for nodec.
 *
 * This is currently a stub: nodec does not yet model C varargs/va_list in a
 * standards-correct way. It exists to let portable code compile; higher-level
 * runtime shims should avoid depending on va_arg semantics where possible.
 */

typedef void *va_list;

#define va_start(ap, last) ((void) ((ap) = (va_list) 0))
#define va_end(ap) ((void) ((ap) = (va_list) 0))
#define va_copy(dest, src) ((void) ((dest) = (src)))
#define va_arg(ap, type) ((type) 0)

#endif

