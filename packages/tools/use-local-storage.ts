import { useState, useEffect } from 'react';

/**
 * React hook for synced localStorage state.
 * @param key The key to use in localStorage.
 * @param initial The initial value or function to compute the initial value.
 * @returns [value, setter, remove] - value is the current state, setter updates the state, remove deletes the key.
 */
function useLocalStorage<T>(key: string, initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => {
    let initialValue: T;
    if (typeof window === 'undefined') {
      initialValue = typeof initial === 'function' ? initial() : initial;
    } else {
      const stored = localStorage.getItem(key);
      initialValue = stored ? JSON.parse(stored) : typeof initial === 'function' ? initial() : initial;
    }
    return initialValue;
  });

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === key) {
        setValue(() => {
          const stored = localStorage.getItem(key);
          return stored ? JSON.parse(stored) : typeof initial === 'function' ? initial() : initial;
        });
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [key, initial]);

  const set = (newValue: T | ((prev: T) => T)) => {
    setValue(prev => {
      const valueToSave = typeof newValue === 'function' ? newValue(prev) : newValue;
      localStorage.setItem(key, JSON.stringify(valueToSave));
      return valueToSave;
    });
  };

  const remove = () => {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(key);
    setValue(() => {
      return typeof initial === 'function' ? initial() : initial;
    });
  };

  return [value, set, remove];
}

export { useLocalStorage };