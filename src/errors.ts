/**
 * Thrown when kindstore cannot safely interpret the store's own internal
 * bookkeeping or format version during open.
 *
 * @remarks
 * Catch this only when your application is prepared to discard the persisted
 * store and recreate it.
 */
export class UnrecoverableStoreOpenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnrecoverableStoreOpenError";
  }
}
