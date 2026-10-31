/**
 * Encrypts API keys before they touch the database.
 * In the app this uses Electron's safeStorage, which is backed by DPAPI on Windows,
 * the Keychain on macOS and libsecret or KWallet on Linux.
 */
export interface KeyVault {
  encrypt(plain: string): Promise<string>
  decrypt(stored: string): Promise<string>
  /** False when the OS offers no secure storage and keys are only obscured. */
  readonly secure: boolean
}

interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plain: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
  /** Linux only. "basic_text" means no keyring was found and a fixed password is used. */
  getSelectedStorageBackend?(): string
}

/**
 * Uses Electron's asynchronous safeStorage calls. The older synchronous ones are deprecated.
 * Keys saved by earlier versions with encryptString still decrypt with decryptStringAsync.
 * Call after the app is ready.
 */
export async function createSafeStorageVault(safeStorage: SafeStorageLike, platform: string = process.platform): Promise<KeyVault> {
  const available = await safeStorage.isAsyncEncryptionAvailable()
  const backend = platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() : undefined
  const secure = available && backend !== 'basic_text' && backend !== 'unknown'
  return {
    secure,
    async encrypt(plain) {
      // basic_text still encrypts (with a fixed key), which is no worse than base64, so use it.
      if (!available) return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
      return `enc:${(await safeStorage.encryptStringAsync(plain)).toString('base64')}`
    },
    async decrypt(stored) {
      if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
      if (stored.startsWith('enc:')) {
        // shouldReEncrypt means the OS rotated its key. The old ciphertext still decrypts, and the
        // key is written again with the new one the next time the user saves the provider.
        return (await safeStorage.decryptStringAsync(Buffer.from(stored.slice(4), 'base64'))).result
      }
      throw new Error('Unrecognized stored key format.')
    }
  }
}

/** For tests only. Keys are base64 encoded, not encrypted. */
export const testVault: KeyVault = {
  secure: false,
  encrypt: async (plain) => `plain:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: async (stored) => Buffer.from(stored.replace(/^plain:/, ''), 'base64').toString('utf8')
}
