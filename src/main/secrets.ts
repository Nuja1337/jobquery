/**
 * Encrypts API keys before they touch the database.
 * In the app this uses Electron's safeStorage, which is backed by DPAPI on Windows,
 * the Keychain on macOS and libsecret on Linux.
 */
export interface KeyVault {
  encrypt(plain: string): string
  decrypt(stored: string): string
  /** False when the OS offers no secure storage and keys are only obfuscated. */
  readonly secure: boolean
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Linux only. "basic_text" means no keyring was found and a fixed password is used. */
  getSelectedStorageBackend?(): string
}

export function createSafeStorageVault(safeStorage: SafeStorageLike, platform: string = process.platform): KeyVault {
  const available = safeStorage.isEncryptionAvailable()
  const backend = platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() : undefined
  const secure = available && backend !== 'basic_text' && backend !== 'unknown'
  return {
    secure,
    encrypt(plain) {
      // basic_text still encrypts (with a fixed key), which is no worse than base64, so use it.
      if (!available) return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
      return `enc:${safeStorage.encryptString(plain).toString('base64')}`
    },
    decrypt(stored) {
      if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
      if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
      throw new Error('Unrecognized stored key format.')
    }
  }
}

/** For tests only. Keys are base64 encoded, not encrypted. */
export const testVault: KeyVault = {
  secure: false,
  encrypt: (plain) => `plain:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (stored) => Buffer.from(stored.replace(/^plain:/, ''), 'base64').toString('utf8')
}
