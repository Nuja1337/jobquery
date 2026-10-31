import type { ProviderInfo, ProviderInput, ProviderKind } from '@shared/types'
import { type Db, newId, now } from '../database'
import type { KeyVault } from '../../secrets'

interface ProviderRow {
  id: string
  kind: ProviderKind
  label: string
  base_url: string | null
  api_key_enc: string | null
  created_at: string
}

function toInfo(row: ProviderRow): ProviderInfo {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    baseUrl: row.base_url,
    hasKey: Boolean(row.api_key_enc),
    createdAt: row.created_at
  }
}

export class ProvidersRepo {
  constructor(
    private readonly db: Db,
    private readonly vault: KeyVault
  ) {}

  list(): ProviderInfo[] {
    return this.db.all<ProviderRow>('SELECT * FROM providers ORDER BY created_at').map(toInfo)
  }

  get(id: string): ProviderInfo | null {
    const row = this.db.get<ProviderRow>('SELECT * FROM providers WHERE id = :id', { id })
    return row ? toInfo(row) : null
  }

  save(input: ProviderInput): ProviderInfo {
    const id = input.id ?? newId()
    const existing = this.db.get<ProviderRow>('SELECT * FROM providers WHERE id = :id', { id })
    // A stored key only stays with the provider it was entered for. If the kind or address
    // changes without a new key, the old key is dropped so it can't be sent somewhere else.
    const newBaseUrl = input.baseUrl?.trim() || null
    const sameTarget = existing !== undefined && existing.kind === input.kind && (existing.base_url ?? null) === newBaseUrl
    const keyEnc = input.apiKey !== undefined
      ? input.apiKey.trim() === '' ? null : this.vault.encrypt(input.apiKey.trim())
      : sameTarget ? existing.api_key_enc : null
    this.db.run(
      `INSERT INTO providers (id, kind, label, base_url, api_key_enc, created_at)
       VALUES (:id, :kind, :label, :baseUrl, :keyEnc, :createdAt)
       ON CONFLICT(id) DO UPDATE SET kind = :kind, label = :label, base_url = :baseUrl, api_key_enc = :keyEnc`,
      {
        id,
        kind: input.kind,
        label: input.label.trim() || input.kind,
        baseUrl: newBaseUrl,
        keyEnc,
        createdAt: existing?.created_at ?? now()
      }
    )
    return this.get(id)!
  }

  delete(id: string): void {
    this.db.run('DELETE FROM providers WHERE id = :id', { id })
  }

  /** Decrypted key. Only the LLM layer should call this. */
  getApiKey(id: string): string | null {
    const row = this.db.get<{ api_key_enc: string | null }>('SELECT api_key_enc FROM providers WHERE id = :id', { id })
    return row?.api_key_enc ? this.vault.decrypt(row.api_key_enc) : null
  }
}
