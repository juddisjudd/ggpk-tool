// Bundle Extractor - Uses ooz's bun_extract_file.exe to extract from POE2 bundled GGPK
// This handles the Oodle-compressed bundle files that make up most of POE2's content

import { spawn } from 'bun';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { postExtractConvertDDS } from '../utils/image-converter';

// Progress callback type
export type ProgressCallback = (info: ProgressInfo) => void;

export interface ProgressInfo {
  phase: 'indexing' | 'filtering' | 'extracting' | 'done';
  current: number;
  total: number;
  currentFile?: string;
  bytesExtracted?: number;
  bundleCount?: number;
  fileCount?: number;
  elapsed?: number;
  rate?: string; // files/sec or MB/s
}

// Find bun_extract_file.exe
function findBunExtractExe(): string {
  const possiblePaths = [
    // Relative to project root
    join(import.meta.dir, '../../external/ooz/build/Release/bun_extract_file.exe'),
    join(import.meta.dir, '../../external/ooz/build/Debug/bun_extract_file.exe'),
    // In PATH
    'bun_extract_file.exe',
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  throw new Error(
    'bun_extract_file.exe not found. Please build ooz first:\n' +
    '  cd external/ooz\n' +
    '  git submodule update --init --recursive\n' +
    '  cmake -B build\n' +
    '  cmake --build build --config Release'
  );
}

export interface BundleExtractorOptions {
  /** Path to Content.ggpk or Steam game directory */
  ggpkPath: string;
  /** Output directory for extracted files */
  outputDir: string;
  /** Use regex patterns instead of exact paths */
  useRegex?: boolean;
}

export interface FileListResult {
  bundleCount: number;
  fileCount: number;
  files: string[];
}

export interface ExtractionResult {
  extracted: number;
  missed: number;
  total: number;
}

/**
 * List all files available in the bundled GGPK with progress callback
 */
export async function listBundledFiles(
  ggpkPath: string,
  onProgress?: ProgressCallback
): Promise<FileListResult> {
  const exe = findBunExtractExe();
  const startTime = Date.now();
  
  onProgress?.({
    phase: 'indexing',
    current: 0,
    total: 0,
    currentFile: 'Decompressing index bundle...'
  });
  
  const proc = spawn([exe, 'list-files', ggpkPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  
  if (exitCode !== 0 && !stderr.includes('File count')) {
    throw new Error(`bun_extract_file failed: ${stderr}`);
  }
  
  // Parse header info from stderr
  let bundleCount = 0;
  let fileCount = 0;
  
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.includes('Bundle count in index binary:')) {
      bundleCount = parseInt(trimmed.split(':')[1].trim());
    } else if (trimmed.includes('File count in index binary:')) {
      fileCount = parseInt(trimmed.split(':')[1].trim());
    }
  }
  
  onProgress?.({
    phase: 'indexing',
    current: fileCount,
    total: fileCount,
    bundleCount,
    fileCount,
    currentFile: 'Parsing file list...'
  });
  
  // File paths come from stdout - one per line
  const files = stdout.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
  
  const elapsed = Date.now() - startTime;
  onProgress?.({
    phase: 'done',
    current: files.length,
    total: files.length,
    bundleCount,
    fileCount: files.length,
    elapsed
  });
  
  return { bundleCount, fileCount, files };
}

/**
 * Extract files from bundled GGPK with real-time progress
 * @param options Extraction options
 * @param patterns File paths or regex patterns to extract
 * @param onProgress Optional callback for progress updates
 */
export async function extractBundledFiles(
  options: BundleExtractorOptions,
  patterns: string[],
  onProgress?: ProgressCallback
): Promise<ExtractionResult> {
  const exe = findBunExtractExe();
  const startTime = Date.now();
  
  const args = ['extract-files'];
  if (options.useRegex) {
    args.push('--regex');
  }
  args.push(options.ggpkPath);
  args.push(options.outputDir);
  
  // Use stdin for large file lists to avoid ENAMETOOLONG
  const useStdin = !options.useRegex && patterns.length > 50;
  
  if (!useStdin) {
    args.push(...patterns);
  }
  
  onProgress?.({
    phase: 'extracting',
    current: 0,
    total: patterns.length,
    currentFile: 'Starting extraction...'
  });
  
  const proc = spawn([exe, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: useStdin ? new Blob([patterns.join('\n') + '\n']) : undefined,
  });
  
  // Stream stderr for real-time progress (bun_extract_file outputs progress there)
  let extracted = 0;
  let outputBuffer = '';
  let lastProgressUpdate = Date.now();
  
  // Read stderr in chunks for progress updates
  const stderrReader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  
  try {
    while (true) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      outputBuffer += chunk;
      
      // Parse progress from output - look for extraction messages
      // Example: "Extracting: art/2dart/foo.dds"
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.includes('Extracting:') || line.includes('extracted')) {
          extracted++;
          
          // Throttle progress updates to ~10 per second
          const now = Date.now();
          if (now - lastProgressUpdate > 100) {
            const elapsed = (now - startTime) / 1000;
            const rate = extracted / elapsed;
            
            onProgress?.({
              phase: 'extracting',
              current: extracted,
              total: patterns.length,
              currentFile: line.replace('Extracting:', '').trim().slice(0, 60),
              elapsed: now - startTime,
              rate: `${rate.toFixed(0)} files/s`
            });
            lastProgressUpdate = now;
          }
        }
      }
    }
  } catch (e) {
    // Reader closed, that's ok
  }
  
  // Also read stdout
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  
  // Combine stdout and stderr since bun_extract_file outputs to both
  const output = stdout + '\n' + outputBuffer;
  
  if (exitCode !== 0 && !output.includes('Done,')) {
    throw new Error(`bun_extract_file failed: ${output}`);
  }
  
  // Parse: Done, 1/1 extracted, 0 missed.
  const match = output.match(/Done, (\d+)\/(\d+) extracted, (\d+) missed/);
  if (match) {
    const result = {
      extracted: parseInt(match[1]),
      total: parseInt(match[2]),
      missed: parseInt(match[3]),
    };
    
    onProgress?.({
      phase: 'done',
      current: result.extracted,
      total: result.total,
      elapsed: Date.now() - startTime
    });
    
    return result;
  }
  
  return { extracted: 0, total: patterns.length, missed: patterns.length };
}

// Language patterns to exclude
const NON_ENGLISH_PATTERNS = [
  '/french/', '/german/', '/japanese/', '/korean/', 
  '/portuguese/', '/russian/', '/spanish/', '/thai/',
  '/traditional chinese/', '/simplified chinese/',
  '\\.french\\.', '\\.german\\.', '\\.japanese\\.', '\\.korean\\.',
  '\\.portuguese\\.', '\\.russian\\.', '\\.spanish\\.', '\\.thai\\.',
  '\\.traditional chinese\\.', '\\.simplified chinese\\.'
];

export interface ExtractOptions {
  excludeLanguages?: boolean;
  onProgress?: ProgressCallback;
  convertDDS?: boolean; // Auto-convert DDS to WebP after extraction
}

/**
 * Extract files matching a regex pattern with progress
 */
export async function extractByPattern(
  ggpkPath: string,
  outputDir: string,
  pattern: string,
  options: ExtractOptions = {}
): Promise<ExtractionResult> {
  const { onProgress, convertDDS = true } = options;
  
  let result: ExtractionResult;
  
  if (options.excludeLanguages) {
    // First get all matching files, then filter out non-English
    onProgress?.({
      phase: 'indexing',
      current: 0,
      total: 0,
      currentFile: 'Loading file index...'
    });
    
    const allFiles = await listBundledFiles(ggpkPath, onProgress);
    
    onProgress?.({
      phase: 'filtering',
      current: 0,
      total: allFiles.files.length,
      currentFile: 'Filtering files by pattern...'
    });
    
    const patternRegex = new RegExp(pattern, 'i');
    const langRegex = new RegExp(NON_ENGLISH_PATTERNS.join('|'), 'i');
    
    const filteredFiles = allFiles.files.filter(f => 
      patternRegex.test(f) && !langRegex.test(f)
    );
    
    onProgress?.({
      phase: 'filtering',
      current: filteredFiles.length,
      total: allFiles.files.length,
      currentFile: `Found ${filteredFiles.length} files matching pattern`
    });
    
    if (filteredFiles.length === 0) {
      return { extracted: 0, total: 0, missed: 0 };
    }
    
    // Extract the filtered files directly
    result = await extractBundledFiles(
      { ggpkPath, outputDir, useRegex: false },
      filteredFiles,
      onProgress
    );
  } else {
    result = await extractBundledFiles(
      { ggpkPath, outputDir, useRegex: true },
      [pattern],
      onProgress
    );
  }
  
  // Post-process: Convert DDS to WebP if requested
  if (convertDDS && result.extracted > 0) {
    await postExtractConvertDDS(outputDir, (info) => {
      onProgress?.({
        phase: 'extracting',
        current: info.current,
        total: info.total,
        currentFile: `Converting ${info.file} to WebP...`
      });
    });
  }
  
  return result;
}

/**
 * Extract all files of a specific type
 */
export async function extractByExtension(
  ggpkPath: string,
  outputDir: string,
  extension: string
): Promise<ExtractionResult> {
  // Use regex to match file extension
  const pattern = `.*\\.${extension.replace('.', '')}$`;
  return extractByPattern(ggpkPath, outputDir, pattern);
}

/**
 * Get a quick summary of the GGPK contents
 */
export async function getGGPKSummary(ggpkPath: string): Promise<{
  bundleCount: number;
  fileCount: number;
  sampleFiles: string[];
}> {
  const result = await listBundledFiles(ggpkPath);
  return {
    bundleCount: result.bundleCount,
    fileCount: result.fileCount,
    sampleFiles: result.files.slice(0, 20),
  };
}
