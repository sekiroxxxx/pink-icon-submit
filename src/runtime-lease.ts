import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { AppError } from './errors.js';

/**
 * Holds an operating-system-backed SQLite exclusive lock for the lifetime of
 * the service. The platform deliberately runs as one API/Worker process because
 * its batch file locks are process-local and Worker recovery is startup-owned.
 */
export class RuntimeLease {
  private closed = false;

  private constructor(private readonly database: Database.Database) {}

  static acquire(path: string): RuntimeLease {
    mkdirSync(dirname(path), { recursive: true });
    const database = new Database(path, { timeout: 0 });
    try {
      database.pragma('busy_timeout = 0');
      database.exec('BEGIN EXCLUSIVE');
      return new RuntimeLease(database);
    } catch (error) {
      database.close();
      if (error instanceof Error && /locked|busy/i.test(error.message)) {
        throw new AppError(
          'RUNTIME_ALREADY_RUNNING',
          'Another PinK Icon Submit process already owns this data directory.',
          503,
        );
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.exec('ROLLBACK');
    this.database.close();
  }
}
