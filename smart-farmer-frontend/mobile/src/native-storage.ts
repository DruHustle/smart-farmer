import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import * as LocalAuthentication from 'expo-local-authentication';
import { LocalRepository } from './repository';
import type { Language, Session } from './types';

const SESSION_KEY = 'smart-farmer.current-session.v1';
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function accountKey(session: Pick<Session, 'origin' | 'userId'>): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${session.origin}\n${session.userId}`);
}

export async function readSession(origin: string): Promise<Session | null> {
  const value = await SecureStore.getItemAsync(SESSION_KEY, OPTIONS);
  if (!value) return null;
  try {
    const session = JSON.parse(value) as Session;
    if (session.origin !== origin || !session.userId || !session.username || !session.token || !Number.isFinite(Date.parse(session.expiresAt))) return null;
    return session;
  } catch { return null; }
}

export async function saveSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), OPTIONS);
}

export async function forgetSession(): Promise<void> { await SecureStore.deleteItemAsync(SESSION_KEY, OPTIONS); }

export async function readLanguage(): Promise<Language> {
  const value = await SecureStore.getItemAsync('smart-farmer.language');
  return value === 'nd' ? 'nd' : 'sn';
}
export async function saveLanguage(language: Language): Promise<void> { await SecureStore.setItemAsync('smart-farmer.language', language, OPTIONS); }

export async function deviceUnlock(promptMessage: string, cancelLabel: string): Promise<boolean> {
  const security = await LocalAuthentication.getEnrolledLevelAsync();
  if (security === LocalAuthentication.SecurityLevel.NONE) throw new Error('deviceLock');
  const result = await LocalAuthentication.authenticateAsync({ promptMessage, cancelLabel, disableDeviceFallback: false, biometricsSecurityLevel: 'strong' });
  return result.success;
}

/** Never create a plaintext cache in Expo Go or in a build missing the native encryption plugin. */
export async function openRepository(session: Session): Promise<LocalRepository> {
  const key = await accountKey(session);
  const db = await SQLite.openDatabaseAsync(`farm-${key}.db`);
  try {
    const cipher = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version');
    if (!cipher?.cipher_version) throw new Error('encryption_unavailable');
    const secretName = `smart-farmer.vault.${key}`;
    let password = await SecureStore.getItemAsync(secretName, OPTIONS);
    if (!password) {
      password = Array.from(await Crypto.getRandomBytesAsync(32)).map(byte => byte.toString(16).padStart(2, '0')).join('');
      await SecureStore.setItemAsync(secretName, password, OPTIONS);
    }
    if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('encryption_unavailable');
    await db.execAsync(`PRAGMA key = '${password}'`);
    const repository = new LocalRepository(db);
    await repository.initialize();
    return repository;
  } catch (error) { await db.closeAsync(); throw error; }
}
