/**
 * Utility functions for NebGov app
 */

/**
 * Validate if a string is a valid Stellar address
 */
export function isValidStellarAddress(address: string): boolean {
  if (!address) return false;
  
  // Stellar addresses:
  // - Start with 'G' or 'M' (mainnet or testnet)
  // - Are 56 characters long
  // - Use Base32 encoding (only contain A-Z and 2-7)
  const stellarAddressRegex = /^[GM][A-Z2-7]{54}$/;
  return stellarAddressRegex.test(address);
}

/**
 * Format a Stellar address for display (truncate or show federation name)
 */
export function formatStellarAddress(
  address: string,
  truncate: boolean = false,
  maxLength: number = 8
): string {
  if (!address) return "";
  
  if (!truncate || address.length <= maxLength * 2) {
    return address;
  }
  
  return `${address.slice(0, maxLength)}...${address.slice(-maxLength)}`;
}

/**
 * Format voting power display
 */
export function formatVotingPower(power: bigint, decimals: number = 7): string {
  const displayValue = Number(power) / Math.pow(10, decimals);
  return displayValue.toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  });
}

/**
 * Calculate percentage with safe division
 */
export function calculatePercentage(
  value: bigint,
  total: bigint,
  precision: number = 2
): number {
  if (total === 0n) return 0;
  return Number((value * 10000n) / total) / (100 * precision);
}
