/** Mock mode is enabled with `VITE_MOCK=1` (offline UI dev, no real API / no token). */
export function isMockMode(): boolean {
  try {
    return import.meta.env?.VITE_MOCK === '1';
  } catch {
    return false;
  }
}
