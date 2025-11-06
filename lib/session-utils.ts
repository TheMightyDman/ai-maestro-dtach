/**
 * Session Utilities
 * Shared validation and normalization functions for session management
 */

/**
 * Valid session name pattern for both tmux and dtach
 * Allows alphanumeric characters, hyphens, and underscores
 */
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * Normalizes and validates a session name
 * @param value - The value to normalize
 * @returns The normalized session name, or null if invalid
 */
export function normalizeSessionName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!SESSION_NAME_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}

/**
 * Validates if a session name is valid
 * @param name - The session name to validate
 * @returns True if the name is valid, false otherwise
 */
export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_PATTERN.test(name.trim())
}
