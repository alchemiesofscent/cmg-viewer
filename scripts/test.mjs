import { spawnSync } from 'node:child_process';

const commands = [
  ['scripts/python.mjs', '-m', 'unittest', 'discover', '-s', 'scripts/tests', '-p', 'test_*.py', '-v'],
  ['--test', 'scripts/tests/test_viewer_gestures.mjs'],
];

for (const arguments_ of commands) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
