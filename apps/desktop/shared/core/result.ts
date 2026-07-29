/**
 * A discriminated union representing the outcome of an operation.
 * Forces the consumer to handle both Success and Failure paths explicitly
 * without relying on unstructured thrown exceptions over IPC.
 */
export type Result<T, E = ErrorCode> = 
  | { success: true; data: T }
  | { success: false; error: AppError<E> };

export type ErrorCode = 
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "INTERNAL_ERROR"
  | "TIMEOUT"
  | "CANCELLED";

export interface AppError<E = ErrorCode> {
  code: E;
  message: string;
  details?: Record<string, unknown>;
}

export const Result = {
  ok: <T>(data: T): Result<T, never> => ({
    success: true,
    data,
  }),

  fail: <E = ErrorCode>(code: E, message: string, details?: Record<string, unknown>): Result<never, E> => ({
    success: false,
    error: { code, message, details },
  }),
};
