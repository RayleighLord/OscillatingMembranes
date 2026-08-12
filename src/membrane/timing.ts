/** Deliberately slow visual period assigned to the lowest retained mode. */
export const FUNDAMENTAL_CYCLE_SECONDS = 10;

/**
 * Return omega_n / omega_1 for Laplacian eigenvalues, where omega is
 * proportional to sqrt(lambda).
 */
export function frequencyRatioToFundamental(
  eigenvalue: number,
  fundamentalEigenvalue: number
): number {
  assertPositiveFinite(eigenvalue, "eigenvalue");
  assertPositiveFinite(fundamentalEigenvalue, "fundamentalEigenvalue");
  return Math.sqrt(eigenvalue / fundamentalEigenvalue);
}

/** Visual cycle duration that preserves the exact relative modal frequency. */
export function animationCycleSeconds(
  eigenvalue: number,
  fundamentalEigenvalue: number
): number {
  return (
    FUNDAMENTAL_CYCLE_SECONDS /
    frequencyRatioToFundamental(eigenvalue, fundamentalEigenvalue)
  );
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number; received ${String(value)}.`);
  }
}
