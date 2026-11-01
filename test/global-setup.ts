import { execSync } from 'node:child_process';

/** Integration tests drive the real bundled CLI, so build it once before any test file runs. */
export default function setup(): void {
  execSync('npm run build --silent', { stdio: 'inherit' });
}
