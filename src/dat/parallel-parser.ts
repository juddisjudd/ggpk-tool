// Parallel DAT Parser - uses Bun Web Workers for multi-threaded parsing
import { readdir, mkdir } from 'fs/promises';
import * as path from 'path';
import { cpus } from 'os';
import { logger } from '../utils/logger';

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

export interface ParallelParseOptions {
  filter?: string;
  limit?: number;
  concurrency?: number;
  useCache?: boolean;
}

export interface ParallelParseResult {
  success: number;
  failed: number;
  skipped: number;
  cached: number;
  totalRows: number;
  elapsedMs: number;
}

/**
 * Run a batch of tasks in a single worker with progress callback
 */
function runWorkerBatch(
  workerUrl: string,
  schemaPath: string,
  tasks: ParseTask[],
  useCache: boolean,
  onProgress?: (completed: number, currentFile?: string) => void
): Promise<ParseResult[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);
    let initialized = false;
    
    worker.onmessage = (event) => {
      const msg = event.data;
      
      if (msg.type === 'ready') {
        initialized = true;
        // Send batch after init
        worker.postMessage({ 
          type: 'batch', 
          tasks,
          checkCache: useCache
        });
      } else if (msg.type === 'progress') {
        // Progress update - count=0 means "starting", count=1 means "done"
        onProgress?.(msg.count || 0, msg.currentFile);
      } else if (msg.type === 'batch-result') {
        worker.terminate();
        resolve(msg.results);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.error));
      }
    };
    
    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
    
    // Initialize worker with schema
    worker.postMessage({ type: 'init', schemaPath });
  });
}

/**
 * Parse all .datc64 files in parallel using Bun Web Workers
 */
export async function parseAllDatFilesParallel(
  inputDir: string,
  outputDir: string,
  schemaPath: string,
  options: ParallelParseOptions = {}
): Promise<ParallelParseResult> {
  const startTime = Date.now();
  const numWorkers = options.concurrency || Math.max(1, cpus().length - 1);
  
  logger.info(`Using ${numWorkers} worker threads`);
  
  // Find all .datc64 files
  const files = await readdir(inputDir);
  let datFiles = files.filter(f => f.endsWith('.datc64'));
  
  if (options.filter) {
    const filterLower = options.filter.toLowerCase();
    datFiles = datFiles.filter(f => f.toLowerCase().includes(filterLower));
  }
  
  if (options.limit && options.limit > 0) {
    datFiles = datFiles.slice(0, options.limit);
  }
  
  logger.info(`Found ${datFiles.length} .datc64 files to parse`);
  
  if (datFiles.length === 0) {
    return { success: 0, failed: 0, skipped: 0, cached: 0, totalRows: 0, elapsedMs: 0 };
  }
  
  // Ensure output dir exists
  await mkdir(outputDir, { recursive: true });
  
  // Create tasks
  const tasks: ParseTask[] = datFiles.map(file => {
    const tableName = file.replace('.datc64', '');
    return {
      inputPath: path.join(inputDir, file),
      outputPath: path.join(outputDir, `${tableName}.json`),
      tableName
    };
  });
  
  // Split tasks evenly across workers
  const actualWorkers = Math.min(numWorkers, tasks.length);
  const batchSize = Math.ceil(tasks.length / actualWorkers);
  const batches: ParseTask[][] = [];
  
  for (let i = 0; i < tasks.length; i += batchSize) {
    batches.push(tasks.slice(i, i + batchSize));
  }
  
  // Worker script path - use import.meta to get correct path
  const workerUrl = new URL('./parse-worker.ts', import.meta.url).href;
  
  // Progress tracking
  let completed = 0;
  let currentFile = '';
  let lastStallCheck = Date.now();
  let lastCompleted = 0;
  
  const updateProgress = () => {
    const percent = ((completed / tasks.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = completed > 0 ? (completed / ((Date.now() - startTime) / 1000)).toFixed(0) : '0';
    
    // Check for stall (no progress in 5 seconds)
    const now = Date.now();
    if (now - lastStallCheck > 5000) {
      if (completed === lastCompleted && currentFile) {
        process.stdout.write(`\r[${percent}%] ${completed}/${tasks.length} files (${elapsed}s) - SLOW: ${currentFile}` + ' '.repeat(20));
      }
      lastStallCheck = now;
      lastCompleted = completed;
    } else {
      const fileInfo = currentFile ? ` - ${currentFile.slice(0, 30)}` : '';
      process.stdout.write(`\r[${percent}%] ${completed}/${tasks.length} files (${elapsed}s, ${rate} files/s)${fileInfo}` + ' '.repeat(10));
    }
  };
  
  // Progress callback for workers
  const onProgress = (count: number, file?: string) => {
    if (file) currentFile = file;
    if (count > 0) completed += count;
    updateProgress();
  };
  
  // Initial progress display
  updateProgress();
  
  try {
    // Run all worker batches in parallel
    const batchPromises = batches.map(batch => 
      runWorkerBatch(workerUrl, schemaPath, batch, options.useCache !== false, onProgress)
    );
    
    const batchResults = await Promise.all(batchPromises);
    
    // Flatten results (don't double-count - workers already called onProgress)
    const results: ParseResult[] = [];
    for (const batch of batchResults) {
      results.push(...batch);
    }
    
    // Final progress line
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = tasks.length > 0 ? (tasks.length / ((Date.now() - startTime) / 1000)).toFixed(0) : '0';
    process.stdout.write(`\r[100%] ${tasks.length}/${tasks.length} files (${totalTime}s, ${rate} files/s)` + ' '.repeat(20) + '\n');
    
    // Aggregate results
    const stats: ParallelParseResult = {
      success: 0,
      failed: 0,
      skipped: 0,
      cached: 0,
      totalRows: 0,
      elapsedMs: Date.now() - startTime
    };
    
    for (const result of results) {
      if (result.cached) {
        stats.cached++;
        stats.success++;
      } else if (result.success) {
        stats.success++;
        stats.totalRows += result.rowCount;
      } else if (result.error === 'No schema') {
        stats.skipped++;
      } else {
        stats.failed++;
        if (result.error) {
          logger.warn(`Failed: ${result.tableName}: ${result.error}`);
        }
      }
    }
    
    return stats;
  } catch (error) {
    process.stdout.write('\n');
    throw error;
  }
}
