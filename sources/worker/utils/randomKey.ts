/**
 * Worker-compatible random key generation
 *
 * Uses Web Crypto API instead of Node.js crypto.
 * Generates URL-safe alphanumeric keys.
 */

/**
 * Generate a random alphanumeric key of the specified length.
 * Uses Web Crypto API for Workers compatibility.
 *
 * @param length - Length of the key (default: 24)
 * @returns Random alphanumeric string
 */
export function randomKey(length: number = 24): string {
    const randomBytes = new Uint8Array(length * 2);
    crypto.getRandomValues(randomBytes);

    // Convert to base64 and filter to alphanumeric
    const base64 = btoa(String.fromCharCode(...randomBytes));
    const normalized = base64.replace(/[^a-zA-Z0-9]/g, "");

    // If we don't have enough characters, recurse (unlikely but safe)
    if (normalized.length < length) {
        return randomKey(length);
    }

    return normalized.slice(0, length);
}
