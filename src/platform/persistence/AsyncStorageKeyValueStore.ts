import AsyncStorage from '@react-native-async-storage/async-storage';
import type { KeyValueStore } from '../../domain/persistence/KeyValueStore';

export class AsyncStorageKeyValueStore implements KeyValueStore {
  getString(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  }

  setString(key: string, value: string): Promise<void> {
    return AsyncStorage.setItem(key, value);
  }

  remove(key: string): Promise<void> {
    return AsyncStorage.removeItem(key);
  }
}
