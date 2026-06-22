/** A user-facing error whose message is printed plainly (no stack trace). */
export class BspecError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BspecError";
  }
}
