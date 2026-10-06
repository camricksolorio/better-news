// Exact (Clopper-Pearson) one-sided lower confidence bound for a binomial proportion. D37 reads the join
// audit with it: with n = 150 joins, 2 errors still leaves a 95% lower bound above 0.95, and 3 do not.

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

// P(X >= x) for X ~ Binomial(n, p).
function upperTail(n: number, x: number, p: number): number {
  if (x <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let sum = 0;
  for (let k = x; k <= n; k++) {
    sum += Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
  }
  return sum;
}

// The smallest p for which seeing `successes` or more out of `n` is still plausible at level `alpha`.
export function exactLowerBound(successes: number, n: number, alpha = 0.05): number {
  if (n <= 0 || successes <= 0) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (upperTail(n, successes, mid) < alpha) lo = mid;
    else hi = mid;
  }
  return lo;
}
