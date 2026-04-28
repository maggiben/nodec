#ifndef NODEC_MATH_H
#define NODEC_MATH_H

double floor(double x);
double ceil(double x);
double fabs(double x);
double fmod(double x, double y);
double pow(double x, double y);
double sin(double x);
double cos(double x);
double tan(double x);
double sqrt(double x);
double modf(double x, double *iptr);
double ldexp(double x, int exp);
double frexp(double x, int *exp);

int isfinite(double x);
int isnan(double x);

#endif

