export class LoginCancelledError extends Error {
  constructor(message: string = "Login cancelled by user") {
    super(message)
    this.name = "LoginCancelledError"
  }
}

export class UnsupportedRegionError extends Error {
  constructor(message: string = "Unsupported region") {
    super(message)
    this.name = "UnsupportedRegionError"
  }
}

/** A transport failure whose message is already user-facing, so it must not be re-mapped. */
export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "NetworkError"
  }
}
