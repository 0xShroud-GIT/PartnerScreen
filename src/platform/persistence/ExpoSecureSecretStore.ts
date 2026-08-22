import * as SecureStore from 'expo-secure-store';
import type { SecretStore } from '../../domain/security/SecretStore';

const EXPO_SECURE_STORE_KEY = /^[A-Za-z0-9._-]+$/;

function requireValidSecureStoreKey(key: string): void {
  if (!key || !EXPO_SECURE_STORE_KEY.test(key)) {
    throw new Error('Chirp secure storage key is invalid.');
  }
}

/** Android Keystore-backed secure persistence boundary for small Chirp secrets. */
export class ExpoSecureSecretStore implements SecretStore {
  getSecret(key: string): Promise<string | null> {
    requireValidSecureStoreKey(key);
    return SecureStore.getItemAsync(key);
  }

  setSecret(key: string, value: string): Promise<void> {
    requireValidSecureStoreKey(key);
    return SecureStore.setItemAsync(key, value);
  }

  deleteSecret(key: string): Promise<void> {
    requireValidSecureStoreKey(key);
    return SecureStore.deleteItemAsync(key);
  }
}
