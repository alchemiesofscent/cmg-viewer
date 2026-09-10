import { spawnSync } from 'node:child_process';

const commands = [
  ['scripts/python.mjs', '-m', 'unittest', 'discover', '-s', 'scripts/tests', '-p', 'test_*.py', '-v'],
  ['--test', 'scripts/tests/test_viewer_export.mjs', 'scripts/tests/test_viewer_data.mjs', 'scripts/tests/test_viewer_continuity.mjs', 'scripts/tests/test_viewer_gestures.mjs', 'scripts/tests/test_viewer_navigation.mjs', 'scripts/tests/test_viewer_loading.mjs', 'scripts/tests/test_viewer_corpus.mjs', 'scripts/tests/test_viewer_tools.mjs', 'scripts/tests/test_viewer_share.mjs', 'scripts/tests/test_viewer_keyboard.mjs'],
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
