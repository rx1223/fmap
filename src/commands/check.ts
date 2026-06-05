/**
 * `fmap check` — drift detection between the map and code (read-only).
 * (Implemented in M5; exits non-zero on drift so CI can use it later.)
 */
export async function checkCommand(): Promise<void> {
  console.log("check: drift detection not implemented yet (M5).");
}
