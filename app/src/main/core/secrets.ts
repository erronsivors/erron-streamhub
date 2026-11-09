import { safeStorage } from 'electron'
import type { Store } from './db'

/**
 * Секреты (токены, пароли) шифруются Windows DPAPI через Electron safeStorage —
 * расшифровать их может только текущий пользователь Windows на этом ПК.
 * Если шифрование недоступно, секрет НЕ сохраняется (никакого открытого текста).
 */
export class Secrets {
  constructor(private store: Store) {}

  available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  set(key: string, value: string | null): void {
    if (value === null || value === '') {
      this.store.setSecretBlob(key, null)
      return
    }
    if (!this.available()) throw new Error('Шифрование Windows недоступно — секрет не сохранён')
    this.store.setSecretBlob(key, safeStorage.encryptString(value))
  }

  get(key: string): string | null {
    const blob = this.store.getSecretBlob(key)
    if (!blob || !this.available()) return null
    try {
      return safeStorage.decryptString(blob)
    } catch {
      return null
    }
  }

  has(key: string): boolean {
    return this.store.getSecretBlob(key) !== null
  }
}
