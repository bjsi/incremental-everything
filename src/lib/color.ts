/**
 * Converts a percentile (1-100) into an HSL color string.
 * Lower percentiles (higher priority) are mapped to red/orange (hue ~0).
 * Higher percentiles (lower priority) are mapped to green/blue (hue ~240).
 * @param percentile A number from 1 to 100.
 * @returns An HSL color string (e.g., "hsl(120, 80%, 55%)").
 */
export function percentileToHslColor(percentile: number): string {
  // Round to nearest integer FIRST for consistent colors
  const roundedPercentile = Math.round(percentile);

  // Clamp the percentile to be within the 1-100 range
  const clampedPercentile = Math.max(1, Math.min(100, roundedPercentile));
  
  // Map the 1-100 percentile range to a 0-240 hue range.
  // Hue 0 is red, 120 is green, 240 is blue.
  const hue = (clampedPercentile / 100) * 240;
  
  const saturation = '80%';
  const lightness = '55%';
  
  return `hsl(${hue}, ${saturation}, ${lightness})`;
}