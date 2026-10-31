import type { ProviderBilling, ProviderInfo, ProviderInput, ProviderKind } from '@shared/types'
import { type Db, newId, now } from '../database'
import type { KeyVault } from '../../secrets'

interface ProviderRow {
  id: string
  kind: ProviderKind
  label: string
  base_url: string | null
  api_key_enc: string | null
  billing: ProviderBilling
  requests_per_minute: number | null
  requests_per_day: number | null
  created_at: string
}

/** A positive whole number, or null for no limit. Anything else (zero, negative, NaN, text) means no limit. */
export function cleanLimit(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const n = Math.floor(value)
  return n >= 1 ? n : null
}

/**
 * Ollama costs nothing. Everything else is assumed paid until the user marks it free, even an
 * address on this computer, since that can be a proxy that forwards to a paid API.
 */
export function defaultBilling(kind: ProviderKind, _baseUrl: string | null): ProviderBilling {
  return kind === 'ollama' ? 'free' : 'paid'
}

function toInfo(row: ProviderRow): ProviderInfo {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    baseUrl: row.base_url,
    hasKey: Boolean(row.api_key_enc),
    billing: row.billing === 'free' ? 'free' : 'paid',
    requestsPerMinute: row.requests_per_minute,
    requestsPerDay: row.requests_per_day,
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

  async save(input: ProviderInput): Promise<ProviderInfo> {
    // Encrypt first, so everything after it runs without a pause another save could slip into.
    const newKey = input.apiKey?.trim() ? await this.vault.encrypt(input.apiKey.trim()) : null
    const id = input.id ?? newId()
    const existing = this.db.get<ProviderRow>('SELECT * FROM providers WHERE id = :id', { id })
    // A stored key only stays with the provider it was entered for. If the kind or address
    // changes without a new key, the old key is dropped so it can't be sent somewhere else.
    const newBaseUrl = input.baseUrl?.trim() || null
    const sameTarget = existing !== undefined && existing.kind === input.kind && (existing.base_url ?? null) === newBaseUrl
    const keyEnc = input.apiKey !== undefined ? newKey : sameTarget ? existing.api_key_enc : null
    // A missing value keeps what is stored. A new provider gets the defaults.
    const billing: ProviderBilling = input.billing ?? existing?.billing ?? defaultBilling(input.kind, newBaseUrl)
    const perMinute = input.requestsPerMinute !== undefined ? cleanLimit(input.requestsPerMinute) : (existing?.requests_per_minute ?? null)
    const perDay = input.requestsPerDay !== undefined ? cleanLimit(input.requestsPerDay) : (existing?.requests_per_day ?? null)
    this.db.run(
      `INSERT INTO providers (id, kind, label, base_url, api_key_enc, billing, requests_per_minute, requests_per_day, created_at)
       VALUES (:id, :kind, :label, :baseUrl, :keyEnc, :billing, :perMinute, :perDay, :createdAt)
       ON CONFLICT(id) DO UPDATE SET kind = :kind, label = :label, base_url = :baseUrl, api_key_enc = :keyEnc,
         billing = :billing, requests_per_minute = :perMinute, requests_per_day = :perDay`,
      {
        id,
        kind: input.kind,
        label: input.label.trim() || input.kind,
        baseUrl: newBaseUrl,
        keyEnc,
        billing: billing === 'free' ? 'free' : 'paid',
        perMinute,
        perDay,
        createdAt: existing?.created_at ?? now()
      }
    )
    return this.get(id)!
  }

  delete(id: string): void {
    this.db.run('DELETE FROM providers WHERE id = :id', { id })
  }

  /** Decrypted key. Only the LLM layer should call this. */
  async getApiKey(id: string): Promise<string | null> {
    const row = this.db.get<{ api_key_enc: string | null }>('SELECT api_key_enc FROM providers WHERE id = :id', { id })
    return row?.api_key_enc ? this.vault.decrypt(row.api_key_enc) : null
  }
}
