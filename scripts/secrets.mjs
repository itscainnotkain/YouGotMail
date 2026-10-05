import { randomBytes } from 'node:crypto';
console.log('SETUP_TOKEN=' + randomBytes(32).toString('base64url'));
console.log('APP_KEY=' + randomBytes(32).toString('base64'));
console.log('\nKeep both values private. Store APP_KEY with your backups.');
