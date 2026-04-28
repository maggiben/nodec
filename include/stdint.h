#ifndef NODEC_STDINT_H
#define NODEC_STDINT_H

/* Minimal C99 stdint for nodec-compiled programs. */

typedef signed char int8_t;
typedef unsigned char uint8_t;

typedef short int16_t;
typedef unsigned short uint16_t;

typedef int int32_t;
typedef unsigned int uint32_t;

typedef long long int64_t;
typedef unsigned long long uint64_t;

typedef long intptr_t;
typedef unsigned long uintptr_t;

#define INT8_MIN (-128)
#define INT8_MAX 127
#define UINT8_MAX 255u

#define INT16_MIN (-32768)
#define INT16_MAX 32767
#define UINT16_MAX 65535u

#define INT32_MIN (-2147483647 - 1)
#define INT32_MAX 2147483647
#define UINT32_MAX 4294967295u

#define INT64_MAX 9223372036854775807ll
#define INT64_MIN (-9223372036854775807ll - 1)
#define UINT64_MAX 18446744073709551615ull

#define INTPTR_MAX ((intptr_t) (UINTPTR_MAX / 2))
#define INTPTR_MIN (-INTPTR_MAX - 1)
#define UINTPTR_MAX ((uintptr_t) (~(uintptr_t) 0))

#endif

