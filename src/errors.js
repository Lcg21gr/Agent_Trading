export class ApiError extends Error {
  constructor(code, status = 422) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Only definite, correlated broker rejections use this type. Transport errors
// after sending a command must retain an uncertain outcome.
export class BrokerRejection extends ApiError {
  constructor(tokenInvalid = false, command = true) {
    super(command ? 'BROKER_REJECTED' : 'BROKER_REQUEST_REJECTED', command ? 422 : 502);
    this.tokenInvalid = tokenInvalid;
  }
}

export function requireValue(condition, code, status = 422) {
  if (!condition) throw new ApiError(code, status);
}
