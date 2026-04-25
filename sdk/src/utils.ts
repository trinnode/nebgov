/**
 * Computes the effective vote weight under quadratic voting.
 *
 * Under VoteType::Quadratic the governor uses floor(sqrt(rawBalance)) as the
 * weight, so a holder with 10,000 tokens has a weight of 100, not 10,000.
 */
export function computeQuadraticWeight(rawBalance: bigint): bigint {
  if (rawBalance < 0n) {
    throw new Error("rawBalance must be non-negative");
  }
  return BigInt(Math.floor(Math.sqrt(Number(rawBalance))));
}

/**
 * Robust hex-to-32-byte-buffer conversion utility for Soroban SDK.
 *
 * This handles stripping '0x' prefixes, padding, and validation
 * to ensure we pass correctly sized BytesN<32> equivalents to the contract.
 *
 * @param hex - Hexadecimal string (optionally prefixed with 0x)
 * @returns Uint8Array of exactly 32 bytes
 * @throws Error if hex is invalid or results in wrong byte length
 */
export function hexToBytes32(hex: string): Uint8Array {
    // Strip 0x if present
    let clean = hex.startsWith("0x") ? hex.substring(2) : hex;

    if (clean.length !== 64) {
        throw new Error(`Invalid hex length for BytesN<32>: expected 64 chars, got ${clean.length}`);
    }

    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        const byte = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        if (isNaN(byte)) {
            throw new Error(`Invalid hex character at position ${i * 2}`);
        }
        bytes[i] = byte;
    }
    return bytes;
}
