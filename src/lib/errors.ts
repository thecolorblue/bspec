/** A user-facing error whose message is printed plainly (no stack trace). */
export class BspecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BspecError";
  }
}
