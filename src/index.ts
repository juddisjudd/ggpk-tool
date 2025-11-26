#!/usr/bin/env bun

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from './config';
import { extractFiles, listFiles } from './tasks/extract';
import { extractTree } from './tasks/extract-tree';
import { extractAll, extractCategory } from './tasks/extract-all';
import { parseDat, parseAllDat } from './tasks/parse-dat';
import { convertDDS } from './tasks/convert-dds';
import { logger } from './utils/logger';
import { 
  listBundledFiles, 
  extractBundledFiles, 
  extractByPattern,
  getGGPKSummary,
  type ProgressInfo
} from './ggpk/bundle-extractor';

// Progress callback for extraction commands
const progressHandler = (info: ProgressInfo) => {
  logger.progress(info.current, info.total, {
    phase: info.phase,
    currentFile: info.currentFile,
    rate: info.rate,
    elapsed: info.elapsed
  });
};

const program = new Command();

program
  .name('ggpk-extract')
  .description('POE2 Content.ggpk asset extraction tool')
  .version('0.1.0');

// Extract everything from GGPK
program
  .command('extract-all')
  .description('Extract ALL files from Content.ggpk')
  .option('-o, --output <dir>', 'Output directory')
  .action(async (options) => {
    try {
      const config = await loadConfig();
      await extractAll(config, {
        outputDir: options.output || config.outputDir,
        includeAll: true
      });
      logger.success('Complete extraction finished!');
    } catch (error) {
      logger.error('Extraction failed:', error);
      process.exit(1);
    }
  });

// Extract by category
program
  .command('extract-category <category>')
  .description('Extract specific category of assets (metadata, data, images, ui, audio, models, shaders, animations)')
  .option('-o, --output <dir>', 'Output directory')
  .action(async (category, options) => {
    try {
      const config = await loadConfig();
      if (options.output) {
        config.outputDir = options.output;
      }
      await extractCategory(category, config);
      logger.success(`${category} extraction complete!`);
    } catch (error) {
      logger.error('Extraction failed:', error);
      process.exit(1);
    }
  });

// Extract tree assets
program
  .command('extract-tree')
  .description('Extract passive tree assets (icons, backgrounds, data)')
  .option('-v, --version <version>', 'Tree version', '0_3')
  .option('-o, --output <dir>', 'Output directory')
  .option('--copy-to-app', 'Copy extracted assets to main app', false)
  .action(async (options) => {
    try {
      const config = await loadConfig();
      await extractTree({
        ...config,
        treeVersion: options.version,
        outputDir: options.output || config.outputDir,
        copyToApp: options.copyToApp
      });
      logger.success('Tree extraction complete!');
    } catch (error) {
      logger.error('Tree extraction failed:', error);
      process.exit(1);
    }
  });

// Extract files by pattern
program
  .command('extract')
  .description('Extract files matching pattern(s)')
  .option('-p, --pattern <patterns...>', 'File patterns to extract')
  .option('-o, --output <dir>', 'Output directory')
  .option('-f, --file <file>', 'Extract specific file path')
  .action(async (options) => {
    try {
      const config = await loadConfig();
      const patterns = options.pattern || [];
      
      if (options.file) {
        patterns.push(options.file);
      }
      
      if (patterns.length === 0) {
        logger.error('No patterns specified. Use --pattern or --file');
        process.exit(1);
      }
      
      await extractFiles(patterns, options.output || config.outputDir, config);
      logger.success('Extraction complete!');
    } catch (error) {
      logger.error('Extraction failed:', error);
      process.exit(1);
    }
  });

// List files
program
  .command('list')
  .description('List files in GGPK matching pattern')
  .option('-p, --pattern <pattern>', 'File pattern', '**/*')
  .option('-l, --limit <number>', 'Limit results', '100')
  .action(async (options) => {
    try {
      const config = await loadConfig();
      const files = await listFiles(options.pattern, config);
      
      const limit = parseInt(options.limit);
      const displayFiles = files.slice(0, limit);
      
      console.log(chalk.cyan(`\nFound ${files.length} files matching pattern:\n`));
      displayFiles.forEach(file => console.log(chalk.gray('  ' + file)));
      
      if (files.length > limit) {
        console.log(chalk.yellow(`\n... and ${files.length - limit} more files`));
      }
      
      console.log(chalk.cyan(`\nTotal: ${files.length} files\n`));
    } catch (error) {
      logger.error('List failed:', error);
      process.exit(1);
    }
  });

// Parse .dat file
program
  .command('parse-dat')
  .description('Parse a .datc64 file and export as JSON')
  .option('-f, --file <file>', 'Dat file path (extracted .datc64 file)')
  .option('-o, --output <file>', 'Output JSON file')
  .action(async (options) => {
    try {
      if (!options.file) {
        logger.error('No file specified. Use --file <filename>');
        process.exit(1);
      }
      
      const config = await loadConfig();
      const outputPath = options.output || options.file.replace('.datc64', '.json');
      await parseDat(options.file, outputPath, config);
      logger.success('Parsing complete!');
    } catch (error) {
      logger.error('Parsing failed:', error);
      process.exit(1);
    }
  });

// Parse all .dat files
program
  .command('parse-all-dat')
  .description('Parse all .datc64 files and export as JSON')
  .option('-i, --input <dir>', 'Input directory with .datc64 files')
  .option('-o, --output <dir>', 'Output directory for JSON files')
  .option('--filter <string>', 'Filter tables by name')
  .option('--pretty', 'Pretty print JSON output')
  .option('--limit <number>', 'Limit number of files to parse')
  .option('--sequential', 'Use single-threaded parsing (default: parallel)')
  .option('--no-cache', 'Force re-parse even if output exists and is newer')
  .action(async (options) => {
    try {
      const config = await loadConfig();
      const inputDir = options.input || './extracted/data';
      const outputDir = options.output || './parsed';
      await parseAllDat(inputDir, outputDir, config, {
        filter: options.filter,
        pretty: options.pretty,
        limit: options.limit ? parseInt(options.limit) : undefined,
        parallel: !options.sequential,
        noCache: !options.cache
      });
      logger.success('Parsing complete!');
    } catch (error) {
      logger.error('Parsing failed:', error);
      process.exit(1);
    }
  });

// List available DAT tables
program
  .command('list-tables')
  .description('List all available DAT tables with schemas')
  .action(async () => {
    try {
      const config = await loadConfig();
      const { listDatTables } = await import('./tasks/parse-dat');
      await listDatTables(config);
    } catch (error) {
      logger.error('Failed to list tables:', error);
      process.exit(1);
    }
  });

// Convert DDS files
program
  .command('convert-dds')
  .description('Convert DDS files to PNG/WebP')
  .option('-i, --input <dir>', 'Input directory with DDS files')
  .option('-o, --output <dir>', 'Output directory')
  .option('-f, --format <format>', 'Output format (png, webp)', 'webp')
  .option('-q, --quality <number>', 'Quality (0-100)', '85')
  .action(async (options) => {
    try {
      const config = await loadConfig();
      const inputDir = options.input || config.outputDir;
      const outputDir = options.output || config.outputDir + '-converted';
      const format = (options.format || 'webp') as 'png' | 'webp';
      
      // Override quality in config
      config.conversion = config.conversion || {};
      config.conversion.dds = config.conversion.dds || {};
      config.conversion.dds.quality = parseInt(options.quality);
      
      await convertDDS(inputDir, outputDir, format, config);
      logger.success('Conversion complete!');
    } catch (error) {
      logger.error('Conversion failed:', error);
      process.exit(1);
    }
  });

// Config commands
const configCommand = program
  .command('config')
  .description('Manage configuration');

configCommand
  .command('show')
  .description('Show current configuration')
  .action(async () => {
    try {
      const config = await loadConfig();
      console.log(chalk.cyan('\nCurrent configuration:\n'));
      console.log(JSON.stringify(config, null, 2));
      console.log();
    } catch (error) {
      logger.error('Failed to load config:', error);
      process.exit(1);
    }
  });

configCommand
  .command('set <key> <value>')
  .description('Set configuration value')
  .action(async (key, value) => {
    logger.info(`Setting ${key} = ${value}`);
    logger.warn('Manual config editing not yet implemented. Please edit config.json directly.');
  });

// ============================================
// BUNDLED GGPK COMMANDS (uses ooz for Oodle decompression)
// ============================================

// List bundled files
program
  .command('bundle-list')
  .description('List all files in bundled GGPK (decompresses index)')
  .option('-l, --limit <number>', 'Limit results', '100')
  .option('-p, --pattern <pattern>', 'Filter by pattern (JS regex)')
  .action(async (options) => {
    try {
      const config = await loadConfig();
      logger.section('Listing Bundled GGPK Contents');
      
      const ggpkPath = config.poe2Path + '/Content.ggpk';
      logger.info(`Reading: ${ggpkPath}`);
      
      const result = await listBundledFiles(ggpkPath);
      
      console.log(chalk.cyan(`\nBundle count: ${result.bundleCount}`));
      console.log(chalk.cyan(`Total files: ${result.fileCount}\n`));
      
      let files = result.files;
      
      if (options.pattern) {
        const regex = new RegExp(options.pattern, 'i');
        files = files.filter(f => regex.test(f));
        console.log(chalk.yellow(`Filtered to ${files.length} files matching "${options.pattern}"\n`));
      }
      
      const limit = parseInt(options.limit);
      const displayFiles = files.slice(0, limit);
      
      displayFiles.forEach(file => console.log(chalk.gray('  ' + file)));
      
      if (files.length > limit) {
        console.log(chalk.yellow(`\n... and ${files.length - limit} more files`));
      }
      
      console.log(chalk.cyan(`\nShowing ${displayFiles.length} of ${files.length} files\n`));
    } catch (error) {
      logger.error('List failed:', error);
      process.exit(1);
    }
  });

// Extract from bundled GGPK
program
  .command('bundle-extract')
  .description('Extract files from bundled GGPK (Oodle-compressed)')
  .option('-p, --pattern <pattern>', 'Regex pattern to match files')
  .option('-f, --files <files...>', 'Specific file paths to extract')
  .option('-o, --output <dir>', 'Output directory', './extracted')
  .action(async (options) => {
    try {
      const config = await loadConfig();
      logger.section('Extracting from Bundled GGPK');
      
      const ggpkPath = config.poe2Path + '/Content.ggpk';
      logger.info(`Reading: ${ggpkPath}`);
      logger.info(`Output: ${options.output}`);
      console.log(); // Space for progress bar
      
      let result;
      
      if (options.pattern) {
        logger.info(`Pattern: ${options.pattern}`);
        result = await extractByPattern(ggpkPath, options.output, options.pattern, {
          onProgress: progressHandler
        });
      } else if (options.files && options.files.length > 0) {
        logger.info(`Extracting ${options.files.length} specific files`);
        result = await extractBundledFiles(
          { ggpkPath, outputDir: options.output },
          options.files,
          progressHandler
        );
      } else {
        logger.error('No pattern or files specified. Use --pattern or --files');
        process.exit(1);
      }
      
      logger.clearProgress();
      logger.success(`Extracted ${result.extracted}/${result.total} files (${result.missed} missed)`);
    } catch (error) {
      logger.clearProgress();
      logger.error('Extraction failed:', error);
      process.exit(1);
    }
  });

// Extract bundled category
program
  .command('bundle-category <category>')
  .description('Extract category from bundled GGPK (data, textures, audio, models, ui)')
  .option('-o, --output <dir>', 'Output directory', './extracted')
  .option('--all-languages', 'Include non-English language files', false)
  .action(async (category, options) => {
    try {
      const config = await loadConfig();
      const ggpkPath = config.poe2Path + '/Content.ggpk';
      
      const categories: Record<string, string> = {
        'data': '.*\\.datc?64$',
        'textures': '.*\\.dds$',
        'audio': '.*\\.(ogg|wav|bank)$',
        'models': '.*\\.(sm|fmt|ao|ast)$',
        'ui': '^art/2dart/.*',
        'skills': '^metadata/effects/spells/.*',
        'items': '^art/2ditems/.*',
        'passives': '^art/2dart/skillicons/passives/.*',
      };
      
      const pattern = categories[category.toLowerCase()];
      if (!pattern) {
        logger.error(`Unknown category: ${category}`);
        logger.info('Available categories: ' + Object.keys(categories).join(', '));
        process.exit(1);
      }
      
      logger.section(`Extracting Category: ${category}`);
      logger.info(`Pattern: ${pattern}`);
      if (!options.allLanguages) {
        logger.info('Excluding non-English languages (use --all-languages to include)');
      }
      console.log(); // Space for progress bar
      
      const result = await extractByPattern(ggpkPath, options.output, pattern, {
        excludeLanguages: !options.allLanguages,
        onProgress: progressHandler
      });
      
      logger.clearProgress();
      logger.success(`Extracted ${result.extracted} files`);
    } catch (error) {
      logger.clearProgress();
      logger.error('Extraction failed:', error);
      process.exit(1);
    }
  });

// Quick GGPK summary
program
  .command('bundle-info')
  .description('Show summary of bundled GGPK contents')
  .action(async () => {
    try {
      const config = await loadConfig();
      const ggpkPath = config.poe2Path + '/Content.ggpk';
      
      logger.section('GGPK Summary');
      logger.info(`Reading: ${ggpkPath}`);
      
      const summary = await getGGPKSummary(ggpkPath);
      
      console.log(chalk.cyan(`\nBundle count: ${summary.bundleCount.toLocaleString()}`));
      console.log(chalk.cyan(`Total files: ${summary.fileCount.toLocaleString()}`));
      console.log(chalk.cyan('\nSample files:'));
      summary.sampleFiles.forEach(f => console.log(chalk.gray('  ' + f)));
      console.log();
    } catch (error) {
      logger.error('Failed to read GGPK:', error);
      process.exit(1);
    }
  });

// Schema update command
program
  .command('update-schema')
  .description('Update the DAT schema from GitHub (poe-tool-dev/dat-schema)')
  .option('-f, --force', 'Force update even if schema is current')
  .action(async (options) => {
    logger.section('Schema Update');
    
    try {
      const { updateSchemaIfNeeded, getSchemaInfo } = await import('./utils/schema-updater');
      
      const before = await getSchemaInfo();
      if (before.exists) {
        console.log(chalk.gray(`Current schema: ${before.createdAt?.toLocaleDateString()} (${before.tableCount} tables)`));
      }
      
      const result = await updateSchemaIfNeeded(options.force);
      
      if (result.updated) {
        console.log(chalk.green(`\n[+] Schema updated! ${result.tableCount} PoE2 tables available.`));
      } else {
        console.log(chalk.green(`\n[+] Schema is already up to date.`));
      }
    } catch (error) {
      logger.error('Schema update failed:', error);
      process.exit(1);
    }
  });

// GUI command
program
  .command('gui')
  .description('Launch web-based GUI for GGPK operations')
  .option('-p, --port <number>', 'Port to run the server on', '3000')
  .option('--open', 'Open browser automatically')
  .option('--no-schema-update', 'Skip automatic schema update check')
  .action(async (options) => {
    logger.section('GGPK Tool GUI');
    
    // Check for schema updates on GUI startup
    if (options.schemaUpdate !== false) {
      try {
        const { updateSchemaIfNeeded } = await import('./utils/schema-updater');
        await updateSchemaIfNeeded();
      } catch (e) {
        console.log(chalk.yellow('[!] Schema update check failed, using existing schema'));
      }
    }
    
    const port = parseInt(options.port, 10);
    const url = `http://localhost:${port}`;
    
    const { startGUI } = await import('./gui/server');
    await startGUI();
    
    console.log(chalk.green(`\n[+] GUI server running at ${chalk.cyan(url)}\n`));
    
    if (options.open) {
      const { exec } = await import('child_process');
      exec(`start ${url}`);
    }
  });

// Parse CLI arguments
program.parse();
