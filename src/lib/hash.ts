/**
 * FNV-1a, 32 bits, hex. Not cryptographic — used where a short, stable id for a
 * string is enough: comparing one failure against another, and deriving mock
 * ETags. Lives in lib/ so mocks/ can use it without lib/ depending on mocks/.
 */
export function fnv1aHex(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
