import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackup, verifyBackup } from './data-backup.js';

function usage(): string {
  return 'Usage: node dist/manage-data.js <backup DESTINATION|verify BACKUP_ROOT>';
}

export async function runManageData(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  output: (message: string) => void = (message) => process.stdout.write(`${message}\n`),
  errorOutput: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<number> {
  try {
    if (args.length !== 2 || (args[0] !== 'backup' && args[0] !== 'verify')) throw new Error(usage());
    const target = resolve(args[1]!);
    if (args[0] === 'backup') {
      const dataRoot = resolve(environment.PINK_ICON_SUBMIT_DATA_DIR ?? 'data');
      await createBackup(dataRoot, target);
      await verifyBackup(target);
      output(`Created and verified backup at ${target}.`);
    } else {
      await verifyBackup(target);
      output(`Verified backup at ${target}.`);
    }
    return 0;
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : 'Data maintenance failed.');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await runManageData(process.argv.slice(2));
}
