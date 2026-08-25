#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const forwarded = process.argv.slice(2);
if (!forwarded.length) {
  console.error('usage: node scripts/python.mjs <script-or-module> [arguments]');
  process.exit(2);
}

const candidates = [];
if (process.env.CMG_PYTHON) candidates.push([process.env.CMG_PYTHON, []]);

if (process.platform === 'win32') {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const pythonRoot = path.join(localAppData, 'Programs', 'Python');
    try {
      const installations = readdirSync(pythonRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^Python\d+$/i.test(entry.name))
        .map((entry) => path.join(pythonRoot, entry.name, 'python.exe'))
        .sort()
        .reverse();
      installations.forEach((executable) => candidates.push([executable, []]));
    } catch {
      // The conventional per-user installation directory is optional.
    }
  }
  candidates.push([
    path.join(
      homedir(),
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'python',
      'python.exe',
    ),
    [],
  ]);
  candidates.push(['py', ['-3']]);
}

candidates.push(['python3', []], ['python', []]);

const selected = candidates.find(([command, prefix]) => {
  const probe = spawnSync(command, [...prefix, '--version'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return probe.status === 0;
});

if (!selected) {
  console.error('CMG Viewer needs Python 3.11 or newer. Set CMG_PYTHON to its executable path.');
  process.exit(1);
}

const [command, prefix] = selected;
const child = spawn(command, [...prefix, ...forwarded], {
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', (error) => {
  console.error(`Could not start Python: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
