import type { WorkerFailureDiagnostic } from './types.js';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function sanitizeDiagnosticText(value: string, maximumLength = 4_000): string {
  return value
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, maximumLength);
}

export function failureDiagnosticFromError(error: unknown): WorkerFailureDiagnostic | undefined {
  if (!isAppError(error) || !isObject(error.details)) {
    return undefined;
  }
  const operation = typeof error.details.operation === 'string'
    ? sanitizeDiagnosticText(error.details.operation, 120)
    : undefined;
  const command = typeof error.details.command === 'string'
    ? sanitizeDiagnosticText(error.details.command, 1_000)
    : undefined;
  const exitCode = typeof error.details.exitCode === 'number' && Number.isInteger(error.details.exitCode)
    ? error.details.exitCode
    : undefined;
  const stderr = typeof error.details.stderr === 'string'
    ? sanitizeDiagnosticText(error.details.stderr)
    : undefined;
  return operation || command || exitCode !== undefined || stderr
    ? { operation, command, exitCode, stderr }
    : undefined;
}
