// Parse .datc64 files to JSON
import { DATParser, parseAllDatFiles } from '../dat/dat-parser';
import { parseAllDatFilesParallel } from '../dat/parallel-parser';
import { logger } from '../utils/logger';
import { writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { Config } from '../config';

const DEFAULT_SCHEMA_PATH = join(process.cwd(), 'schema.min.json');

export async function parseDat(datFilePath: string, outputPath: string, config: Config): Promise<void> {
  logger.section('Parsing DAT File');
  logger.info(`Input: ${datFilePath}`);
  logger.info(`Output: ${outputPath}`);
  
  const schemaPath = config.schemaPath || DEFAULT_SCHEMA_PATH;
  
  if (!existsSync(schemaPath)) {
    throw new Error(`Schema file not found: ${schemaPath}. Run: curl -L -o schema.min.json "https://github.com/poe-tool-dev/dat-schema/releases/download/latest/schema.min.json"`);
  }
  
  try {
    const schema = await DATParser.loadSchema(schemaPath);
    const parser = new DATParser(schema, true);
    
    const result = await parser.parseFile(datFilePath);
    
    if (result.error) {
      logger.warn(`Warning: ${result.error}`);
    }
    
    // Write to JSON
    writeFileSync(outputPath, JSON.stringify(result.rows, null, 2));
    
    logger.success(`Parsed ${result.rowCount} rows from ${result.tableName}`);
    logger.success(`Output: ${outputPath}`);
  } catch (error) {
    logger.error('Failed to parse DAT file:', error);
    throw error;
  }
}

export async function parseAllDat(
  inputDir: string, 
  outputDir: string, 
  config: Config,
  options: { filter?: string; pretty?: boolean; limit?: number; parallel?: boolean; noCache?: boolean } = {}
): Promise<void> {
  logger.section('Parsing All DAT Files');
  
  const schemaPath = config.schemaPath || DEFAULT_SCHEMA_PATH;
  
  if (!existsSync(schemaPath)) {
    throw new Error(`Schema file not found: ${schemaPath}. Run: curl -L -o schema.min.json "https://github.com/poe-tool-dev/dat-schema/releases/download/latest/schema.min.json"`);
  }
  
  logger.info(`Input Dir: ${inputDir}`);
  logger.info(`Output Dir: ${outputDir}`);
  logger.info(`Schema: ${schemaPath}`);
  
  if (options.filter) {
    logger.info(`Filter: ${options.filter}`);
  }
  if (options.limit) {
    logger.info(`Limit: ${options.limit}`);
  }
  
  // Use parallel parser by default, fall back to sequential if issues
  const useParallel = options.parallel !== false;
  
  if (useParallel) {
    logger.info(`Mode: Parallel (multi-threaded)`);
    try {
      const result = await parseAllDatFilesParallel(inputDir, outputDir, schemaPath, {
        filter: options.filter,
        limit: options.limit,
        useCache: !options.noCache
      });
      
      logger.section('Summary');
      logger.success(`Parsed: ${result.success - result.cached} (${result.totalRows.toLocaleString()} rows)`);
      if (result.cached > 0) {
        logger.info(`Cached: ${result.cached}`);
      }
      if (result.failed > 0) {
        logger.error(`Failed: ${result.failed}`);
      }
      if (result.skipped > 0) {
        logger.warn(`No schema: ${result.skipped}`);
      }
      logger.info(`Time: ${(result.elapsedMs / 1000).toFixed(2)}s`);
    } catch (e) {
      // Fall back to sequential on worker errors
      logger.warn(`Parallel parsing failed, falling back to sequential: ${e}`);
      const result = await parseAllDatFiles(inputDir, outputDir, schemaPath, {
        filter: options.filter,
        pretty: options.pretty,
        limit: options.limit,
        useCache: !options.noCache
      });
      
      logger.section('Summary');
      logger.success(`Parsed: ${result.success - result.cached}`);
      if (result.cached > 0) {
        logger.info(`Cached: ${result.cached}`);
      }
      if (result.failed > 0) {
        logger.error(`Failed: ${result.failed}`);
      }
      if (result.skipped > 0) {
        logger.warn(`No schema: ${result.skipped}`);
      }
    }
  } else {
    logger.info(`Mode: Sequential`);
    const result = await parseAllDatFiles(inputDir, outputDir, schemaPath, {
      filter: options.filter,
      pretty: options.pretty,
      limit: options.limit,
      useCache: !options.noCache
    });
    
    logger.section('Summary');
    logger.success(`Parsed: ${result.success - result.cached}`);
      if (result.cached > 0) {
        logger.info(`Cached: ${result.cached}`);
      }
      if (result.failed > 0) {
        logger.error(`Failed: ${result.failed}`);
      }
      if (result.skipped > 0) {
        logger.warn(`No schema: ${result.skipped}`);
      }
  }
}

export async function listDatTables(config: Config): Promise<void> {
  logger.section('Available DAT Tables');
  
  const schemaPath = config.schemaPath || DEFAULT_SCHEMA_PATH;
  
  if (!existsSync(schemaPath)) {
    throw new Error(`Schema file not found: ${schemaPath}. Run: curl -L -o schema.min.json "https://github.com/poe-tool-dev/dat-schema/releases/download/latest/schema.min.json"`);
  }
  
  const schema = await DATParser.loadSchema(schemaPath);
  const parser = new DATParser(schema, true);
  const tables = parser.listTables();
  
  logger.info(`Found ${tables.length} tables for POE2:`);
  
  // Print in columns
  const cols = 4;
  const colWidth = 30;
  for (let i = 0; i < tables.length; i += cols) {
    const row = tables.slice(i, i + cols).map(t => t.padEnd(colWidth)).join('');
    console.log(row);
  }
}
