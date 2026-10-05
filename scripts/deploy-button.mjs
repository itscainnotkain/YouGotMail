import { readFileSync, writeFileSync } from 'node:fs';
const input = process.argv[2];
if (!input) {
  console.error(
    'Usage: npm run deploy:button -- https://github.com/OWNER/REPOSITORY',
  );
  process.exit(1);
}
const url = new URL(input);
if (
  url.protocol !== 'https:' ||
  url.hostname !== 'github.com' ||
  !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname) ||
  url.search ||
  url.hash ||
  url.username ||
  url.password
)
  throw new Error('Use the HTTPS URL of a public GitHub repository.');
const repository = url.href.replace(/\/$/, '').replace(/\.git$/, '');
const link = `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(repository)}`;
const badge = `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](${link})`;
const readme = readFileSync('README.md', 'utf8').replace(
  /<!-- deploy-button:start -->[\s\S]*?<!-- deploy-button:end -->/,
  `<!-- deploy-button:start -->\n${badge}\n<!-- deploy-button:end -->`,
);
writeFileSync('README.md', readme);
console.log(
  `Deployment button configured for ${repository}. Commit README.md to that public repository.\n${link}`,
);
