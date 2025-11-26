import { existsSync } from 'fs';
import { join } from 'path';
import fs from 'fs-extra';

export interface Config {
  poe2Path: string;
  outputDir: string;
  cacheDir: string;
  threads: number;
  schemaPath?: string; // Path to schema.min.json for DAT parsing
  tools: {
    libggpk3: string;
    pypoe: string;
    ooz: string;
  };
  conversion: {
    dds: {
      format: 'png' | 'webp';
      quality: number;
      preserveOriginals: boolean;
    };
  };
  extraction: {
    patterns: Record<string, string[]>;
  };
}

/**
 * Load configuration from config.json or environment variables
 */
export async function loadConfig(): Promise<Config> {
  let config: Partial<Config> = {};

  // Get script directory (where config files should be)
  const scriptDir = join(import.meta.dir, '..');
  const CONFIG_FILE = join(scriptDir, 'config.json');
  const EXAMPLE_CONFIG_FILE = join(scriptDir, 'config.example.json');

  // Try to load config.json
  if (existsSync(CONFIG_FILE)) {
    const fileConfig = await fs.readJson(CONFIG_FILE);
    config = { ...config, ...fileConfig };
  } else if (existsSync(EXAMPLE_CONFIG_FILE)) {
    console.warn(`No config.json found. Copy ${EXAMPLE_CONFIG_FILE} to ${CONFIG_FILE} and customize it.`);
    const exampleConfig = await fs.readJson(EXAMPLE_CONFIG_FILE);
    config = { ...config, ...exampleConfig };
  } else {
    console.warn(`No config files found in ${scriptDir}`);
  }

  // Override with environment variables
  const envConfig: Partial<Config> = {
    poe2Path: process.env.POE2_PATH || config.poe2Path,
    outputDir: process.env.GGPK_OUTPUT_DIR || config.outputDir,
  };

  const mergedConfig = { ...config, ...envConfig } as Config;

  // Validate required fields
  if (!mergedConfig.poe2Path) {
    throw new Error('POE2 path not configured. Set POE2_PATH environment variable or configure in config.json');
  }

  // Set defaults
  mergedConfig.outputDir = mergedConfig.outputDir || './extracted';
  mergedConfig.cacheDir = mergedConfig.cacheDir || './cache';
  mergedConfig.threads = mergedConfig.threads || 4;

  return mergedConfig;
}

/**
 * Get the path to Content.ggpk
 */
export function getGGPKPath(config: Config): string {
  // Try common locations
  const possiblePaths = [
    join(config.poe2Path, 'Content.ggpk'),
    join(config.poe2Path, 'Bundles2', 'Content.ggpk'),
    config.poe2Path // If user specified full path
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new Error(`Content.ggpk not found. Checked:\n${possiblePaths.join('\n')}`);
}

/**
 * Resolve tool path (handles relative paths from script directory)
 */
export function resolveToolPath(toolPath: string): string {
  if (!toolPath) {
    throw new Error('Tool path not specified');
  }

  // If absolute, return as-is
  if (toolPath.startsWith('/') || toolPath.match(/^[A-Z]:\\/i)) {
    return toolPath;
  }

  // Resolve relative to script directory
  const scriptDir = import.meta.dir;
  return join(scriptDir, '..', toolPath);
}
