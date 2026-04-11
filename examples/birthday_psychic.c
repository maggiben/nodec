#include <stdio.h>

int main() {
  int month, age, result;

  printf("--- Birthday Psychic Guessing Game ---\n");
  printf("Follow these steps:\n");
  printf("1. Take your birth month (1-12).\n");
  printf("2. Multiply it by 2.\n");
  printf("3. Add 5.\n");
  printf("4. Multiply by 50.\n");
  printf("5. Add your current age.\n");
  printf("6. Subtract 365.\n");
  printf("7. Add 115.\n");
  printf("Enter the final number: ");
  scanf("%d", &result);

  // The formula: ((Month * 2 + 5) * 50 + Age) - 365 + 115
  // Simplifies to: 100*Month + Age

  age = result % 100;
  month = result / 100;

  printf("\nPsychic Prediction:\n");
  printf("You were born in month: %d\n", month);
  printf("You are: %d years old\n", age);

  return 0;
}
