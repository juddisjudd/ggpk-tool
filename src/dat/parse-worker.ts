// DAT Parser Worker - runs in a separate thread for parallel processing
// Uses Bun's Web Worker API

import { DATParser } from './dat-parser';

declare var self: Worker;

interface ParseTask {
  inputPath: string;
  outputPath: string;
  tableName: string;
}

interface ParseResult {
  tableName: string;
  success: boolean;
  rowCount: number;
  error?: string;
  cached?: boolean;
}

interface WorkerMessage {
  type: 'init' | 'batch';
  schemaPath?: string;
  tasks?: ParseTask[];
  checkCache?: boolean;
}

let parser: DATParser | null = null;

async function initParser(schemaPath: string): Promise<void> {
  const schema = await DATParser.loadSchema(schemaPath);
  parser = new DATParser(schema, true);
}

async function isCached(inputPath: string, outputPath: string): Promise<boolean> {
  try {
    const inputFile = Bun.file(inputPath);
    const outputFile = Bun.file(outputPath);
    
    // Bun.file() provides lastModified property
    if (!await outputFile.exists()) return false;
    return outputFile.lastModified >= inputFile.lastModified;
  } catch {
    return false;
  }
}

async function parseFile(task: ParseTask, checkCache: boolean): Promise<ParseResult> {
  if (!parser) {
    return { tableName: task.tableName, success: false, rowCount: 0, error: 'Parser not initialized' };
  }
  
  // Check if schema exists for this table
  if (!parser.getTableSchema(task.tableName)) {
    return { tableName: task.tableName, success: false, rowCount: 0, error: 'No schema' };
  }

  // Check cache if enabled
  if (checkCache) {
    const skipCached = await isCached(task.inputPath, task.outputPath);
    if (skipCached) {
      return { tableName: task.tableName, success: true, rowCount: 0, cached: true };
    }
  }
  
  try {
    // Bun-optimized file I/O
    const file = Bun.file(task.inputPath);
    
    // Check file exists and has content
    if (!await file.exists()) {
      return { tableName: task.tableName, success: false, rowCount: 0, error: 'File not found' };
    }
    
    const size = file.size;
    if (size === 0) {
      return { tableName: task.tableName, success: false, rowCount: 0, error: 'Empty file' };
    }
    
    // Skip extremely large files that might cause issues (>100MB)
    if (size > 100 * 1024 * 1024) {
      return { tableName: task.tableName, success: false, rowCount: 0, error: `File too large: ${(size / 1024 / 1024).toFixed(1)}MB` };
    }
    
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = parser.parse(buffer, task.tableName);
    
    // Write JSON (compact for smaller files)
    const json = JSON.stringify(result.rows);
    await Bun.write(task.outputPath, json);
    
    return { 
      tableName: task.tableName, 
      success: true, 
      rowCount: result.rowCount,
      error: result.error 
    };
  } catch (e) {
    return { 
      tableName: task.tableName, 
      success: false, 
      rowCount: 0, 
      error: String(e) 
    };
  }
}

async function parseBatch(tasks: ParseTask[], checkCache: boolean): Promise<ParseResult[]> {
  const results: ParseResult[] = [];
  
  for (const task of tasks) {
    // Send "starting" progress so main thread knows what file we're on
    self.postMessage({ type: 'progress', count: 0, currentFile: task.tableName });
    
    const result = await parseFile(task, checkCache);
    results.push(result);
    
    // Send "completed" progress
    self.postMessage({ type: 'progress', count: 1, currentFile: task.tableName, done: true });
  }
  
  return results;
}

// Bun Web Worker message handler
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { type, schemaPath, tasks, checkCache } = event.data;
  
  try {
    switch (type) {
      case 'init':
        if (schemaPath) {
          await initParser(schemaPath);
          self.postMessage({ type: 'ready' });
        }
        break;
        
      case 'batch':
        if (tasks) {
          const results = await parseBatch(tasks, checkCache ?? false);
          self.postMessage({ type: 'batch-result', results });
        }
        break;
    }
  } catch (e) {
    self.postMessage({ type: 'error', error: String(e) });
  }
};
