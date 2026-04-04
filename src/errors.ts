export class UnrecoverableStoreOpenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnrecoverableStoreOpenError";
  }
}
