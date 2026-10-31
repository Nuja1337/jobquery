import { describe, expect, it } from 'vitest'
import { createSafeStorageVault } from './secrets'

/** A stand-in for Electron's safeStorage that reverses bytes instead of encrypting. */
function fakeStorage(available: boolean, backend?: string) {
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (plain: string) => Buffer.from(plain, 'utf8').reverse(),
    decryptStringAsync: async (buf: Buffer) => ({ result: Buffer.from(buf).reverse().toString('utf8'), shouldReEncrypt: false }),
    getSelectedStorageBackend: backend ? () => backend : undefined
  }
}

describe('createSafeStorageVault', () => {
  it('encrypts with the OS key store and reads the key back', async () => {
    const vault = await createSafeStorageVault(fakeStorage(true), 'win32')
    const stored = await vault.encrypt('sk-secret')
    expect(stored.startsWith('enc:')).toBe(true)
    expect(stored).not.toContain('sk-secret')
    expect(await vault.decrypt(stored)).toBe('sk-secret')
    expect(vault.secure).toBe(true)
  })

  it('falls back to an obscured key and says it is not secure when no key store exists', async () => {
    const vault = await createSafeStorageVault(fakeStorage(false), 'win32')
    const stored = await vault.encrypt('sk-secret')
    expect(stored.startsWith('plain:')).toBe(true)
    expect(await vault.decrypt(stored)).toBe('sk-secret')
    expect(vault.secure).toBe(false)
  })

  it("treats Linux's basic_text store as not secure but still encrypts with it", async () => {
    const vault = await createSafeStorageVault(fakeStorage(true, 'basic_text'), 'linux')
    expect(vault.secure).toBe(false)
    expect((await vault.encrypt('k')).startsWith('enc:')).toBe(true)
    const keyring = await createSafeStorageVault(fakeStorage(true, 'gnome_libsecret'), 'linux')
    expect(keyring.secure).toBe(true)
  })

  it('rejects a stored value it does not recognise', async () => {
    const vault = await createSafeStorageVault(fakeStorage(true), 'win32')
    await expect(vault.decrypt('???')).rejects.toThrow(/Unrecognized/)
  })
})
