export {};

declare global {
  interface Map<K, V> {
    get(key: K): unknown extends V ? any : V | undefined;
  }

  interface Set<T> {
    [Symbol.iterator](): SetIterator<unknown extends T ? any : T>;
  }
}
