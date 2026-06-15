import { expect } from "bun:test";

import { UnrecoverableStoreOpenError } from "../../src/index";

export function expectUnrecoverableOpen(open: () => unknown, message: string) {
  let thrown: unknown;
  try {
    open();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UnrecoverableStoreOpenError);
  expect((thrown as Error | undefined)?.message).toContain(message);
}
