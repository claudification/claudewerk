/**
 * Frontend permission types.
 * Server resolves grants and pushes ResolvedPermissions.
 * Client just stores and reads flat boolean flags.
 */

/** Flat resolved permission flags -- pushed by server on WS connect */
export interface ResolvedPermissions {
  canAdmin: boolean
  canChat: boolean
  canReadChat: boolean
  canTerminal: boolean
  canReadTerminal: boolean
  canFiles: boolean
  canReadFiles: boolean
  canSpawn: boolean
  canSettings: boolean
  canVoice: boolean
  canNotifications: boolean
}

/** Default permissions (admin -- everything enabled) */
export const DEFAULT_PERMISSIONS: ResolvedPermissions = {
  canAdmin: true,
  canChat: true,
  canReadChat: true,
  canTerminal: true,
  canReadTerminal: true,
  canFiles: true,
  canReadFiles: true,
  canSpawn: true,
  canSettings: true,
  canVoice: true,
  canNotifications: true,
}
