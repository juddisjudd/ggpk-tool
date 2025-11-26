#!/usr/bin/env bun

/**
 * Initial setup script for GGPK extraction tool
 * Checks prerequisites and builds necessary tools
 */

import { existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

const checks = {
  bun: async () => {
    try {
      const proc = Bun.spawn(['bun', '--version']);
      await proc.exited;
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  },
  
  dotnet: async () => {
    try {
      const proc = Bun.spawn(['dotnet', '--version']);
      await proc.exited;
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  },
  
  python: async () => {
    try {
      const proc = Bun.spawn(['python', '--version']);
      await proc.exited;
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  },
  
  poetry: async () => {
    try {
      const proc = Bun.spawn(['poetry', '--version']);
      await proc.exited;
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  },
  
  libggpk3: () => {
    return existsSync('../../LibGGPK3/LibGGPK3.sln');
  },
  
  pypoe: () => {
    return existsSync('../../PyPoE/pyproject.toml');
  },
  
  ooz: () => {
    return existsSync('../../ooz/CMakeLists.txt');
  },
  
  config: () => {
    return existsSync('config.json');
  }
};

console.log(chalk.cyan.bold('\n--- Checking prerequisites ---\n'));

// Check tools
const results: Record<string, boolean> = {};

for (const [name, check] of Object.entries(checks)) {
  const status = typeof check === 'function' ? await check() : check();
  results[name] = status;
  
  const icon = status ? chalk.green('[+]') : chalk.red('[x]');
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  console.log(`${icon} ${label}: ${status ? chalk.green('Found') : chalk.red('Not found')}`);
}

console.log();

// Summary
const allRequired = results.bun && results.dotnet && results.python && results.poetry;
const allRepos = results.libggpk3 && results.pypoe && results.ooz;

if (!allRequired) {
  console.log(chalk.red.bold('[x] Missing required tools!\n'));
  console.log(chalk.yellow('Please install:'));
  if (!results.bun) console.log('  • Bun: https://bun.sh/');
  if (!results.dotnet) console.log('  • .NET 8.0 SDK: https://dotnet.microsoft.com/download');
  if (!results.python) console.log('  • Python 3.11+: https://www.python.org/downloads/');
  if (!results.poetry) console.log('  • Poetry: https://python-poetry.org/docs/#installation');
  console.log();
  process.exit(1);
}

if (!allRepos) {
  console.log(chalk.yellow.bold('[!] Missing tool repositories!\n'));
  console.log(chalk.yellow('Please clone the following repos to C:\\Repos:'));
  if (!results.libggpk3) console.log('  • git clone https://github.com/aianlinb/LibGGPK3 C:\\Repos\\LibGGPK3');
  if (!results.pypoe) console.log('  • git clone https://github.com/Project-Path-of-Exile-Wiki/PyPoE C:\\Repos\\PyPoE');
  if (!results.ooz) console.log('  • git clone https://github.com/zao/ooz C:\\Repos\\ooz');
  console.log();
  process.exit(1);
}

if (!results.config) {
  console.log(chalk.yellow.bold('[!] No config.json found\n'));
  console.log(chalk.yellow('Creating config.json from example...'));
  
  const fs = await import('fs-extra');
  await fs.copy('config.example.json', 'config.json');
  
  console.log(chalk.green('[+] Created config.json'));
  console.log(chalk.yellow('\nPlease edit config.json and set your POE2 installation path.'));
  console.log();
}

console.log(chalk.green.bold('[+] All prerequisites met!\n'));
console.log(chalk.cyan('Next steps:'));
console.log('  1. Edit config.json with your POE2 path');
console.log('  2. Run: bun run build:libggpk');
console.log('  3. Run: bun run setup:pypoe');
console.log('  4. Run: bun run extract:tree');
console.log();
