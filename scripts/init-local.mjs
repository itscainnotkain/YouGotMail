import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (!existsSync('.dev.vars')) {
  writeFileSync(
    '.dev.vars',
    `SETUP_TOKEN=${randomBytes(32).toString('base64url')}\nAPP_KEY=${randomBytes(32).toString('base64')}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    'Created private local secrets in .dev.vars. Use SETUP_TOKEN from that file to claim your local instance.',
  );
}
const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'db:local'],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
process.exitCode = result.status ?? 1;
