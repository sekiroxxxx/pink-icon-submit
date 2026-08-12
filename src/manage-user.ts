import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthService } from './auth.js';
import { BatchDatabase } from './database.js';
import { RuntimeLease } from './runtime-lease.js';

type UserCommand = 'create' | 'rotate-password' | 'disable';

interface ManageUserIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

function usage(): string {
  return 'Usage: node dist/manage-user.js <create|rotate-password|disable> <username>';
}

function commandFrom(value: string | undefined): UserCommand {
  if (value === 'create' || value === 'rotate-password' || value === 'disable') return value;
  throw new Error(usage());
}

function passwordFromEnvironment(environment: NodeJS.ProcessEnv): string {
  const password = environment.PINK_ICON_MANAGE_USER_PASSWORD;
  if (!password) throw new Error('PINK_ICON_MANAGE_USER_PASSWORD is required for this command.');
  return password;
}

export async function runManageUser(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  io: ManageUserIo = {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
  },
): Promise<number> {
  let database: BatchDatabase | undefined;
  let runtimeLease: RuntimeLease | undefined;
  try {
    if (args.length !== 2) throw new Error(usage());
    const command = commandFrom(args[0]);
    const username = args[1]!;
    const password = command === 'disable' ? undefined : passwordFromEnvironment(environment);
    const dataRoot = resolve(environment.PINK_ICON_SUBMIT_DATA_DIR ?? 'data');
    const databasePath = resolve(dataRoot, 'pink-icon-submit.sqlite');
    runtimeLease = RuntimeLease.acquire(`${databasePath}.runtime-lock`);
    database = new BatchDatabase(databasePath);
    const auth = new AuthService(database);

    if (command === 'create') {
      const user = await auth.createManagedUser({ username, password: password! });
      io.stdout(`Created user ${user.username}.`);
    } else if (command === 'rotate-password') {
      const user = await auth.rotateManagedUserPassword({ username, password: password! });
      io.stdout(`Rotated password and revoked sessions for ${user.username}.`);
    } else {
      const user = auth.disableManagedUser(username);
      io.stdout(`Disabled user and revoked sessions for ${user.username}.`);
    }
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : 'User management failed.');
    return 1;
  } finally {
    try {
      database?.close();
    } finally {
      runtimeLease?.close();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await runManageUser(process.argv.slice(2));
}
