export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function fibonacci(n: number): number {
  if (n <= 1) return n;
  return add(fibonacci(n - 1), fibonacci(n - 2));
}