import type { DeepPartial } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { normalizeEeo } from '@shared/eeo'
import type { Settings } from '@shared/types'
import { type Db, parseJson } from '../database'

/** Merges patch into base. Objects merge key by key. Arrays and plain values replace. */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch as T
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue
    out[key] = deepMerge((base as Record<string, unknown>)[key], value as DeepPartial<unknown>)
  }
  return out as T
}

export class SettingsRepo {
  private cache: Settings | null = null

  constructor(private readonly db: Db) {}

  get(): Settings {
    if (this.cache) return this.cache
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings')
    let settings: Settings = structuredClone(DEFAULT_SETTINGS)
    for (const row of rows) {
      if (!(row.key in DEFAULT_SETTINGS)) continue
      let stored = parseJson<unknown>(row.value, undefined)
      // Read the raw eeo row before merging. Merged over the defaults, an old row would look current.
      if (row.key === 'eeo') stored = normalizeEeo(stored)
      settings = deepMerge<Settings>(settings, { [row.key]: stored } as DeepPartial<Settings>)
    }
    this.cache = settings
    return settings
  }

  update(patch: DeepPartial<Settings>): Settings {
    const next = deepMerge<Settings>(this.get(), patch)
    if (patch.eeo !== undefined) next.eeo = normalizeEeo(next.eeo)
    this.db.transaction(() => {
      for (const key of Object.keys(patch) as Array<keyof Settings>) {
        this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)', {
          key,
          value: JSON.stringify(next[key])
        })
      }
    })
    this.cache = next
    return next
  }

  /** Removes one price override so the built-in price applies again. */
  removePrice(model: string): Settings {
    const prices = { ...this.get().prices }
    delete prices[model]
    this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)', { key: 'prices', value: JSON.stringify(prices) })
    this.cache = { ...this.get(), prices }
    return this.cache
  }
}
