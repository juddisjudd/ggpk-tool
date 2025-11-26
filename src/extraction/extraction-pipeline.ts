// Unified Extraction Pipeline
// Extracts files from GGPK with automatic post-processing:
// - DAT files → JSON (with DAT cleanup)
// - DDS files → WebP (with DDS cleanup)
// - Audio files → kept as-is

import { extractByPattern, listBundledFiles, type ProgressCallback, type ProgressInfo } from '../ggpk/bundle-extractor';
import { convertDDStoWebP } from '../utils/image-converter';
import { DATParser } from '../dat/dat-parser';
import { readdir, unlink, stat, writeFile } from 'fs/promises';
import { join, basename, extname } from 'path';
import { existsSync } from 'fs';

export interface ExtractionPipelineOptions {
  /** Path to Content.ggpk */
  ggpkPath: string;
  /** Output directory (default: ./extracted) */
  outputDir?: string;
  /** Path to schema file for DAT parsing */
  schemaPath?: string;
  /** Convert DDS to WebP and delete originals */
  convertImages?: boolean;
  /** Parse DAT to JSON and delete originals */
  parseDatFiles?: boolean;
  /** Exclude non-English language files */
  excludeLanguages?: boolean;
  /** Progress callback */
  onProgress?: ProgressCallback;
}

export interface PipelineResult {
  extracted: number;
  images: { converted: number; failed: number };
  data: { parsed: number; failed: number };
  elapsed: number;
}

/**
 * Extract files with automatic post-processing
 */
export async function runExtractionPipeline(
  pattern: string,
  options: ExtractionPipelineOptions
): Promise<PipelineResult> {
  const {
    ggpkPath,
    outputDir = './extracted',
    schemaPath = './schema.min.json',
    convertImages = true,
    parseDatFiles = true,
    excludeLanguages = true,
    onProgress
  } = options;

  const startTime = Date.now();
  const result: PipelineResult = {
    extracted: 0,
    images: { converted: 0, failed: 0 },
    data: { parsed: 0, failed: 0 },
    elapsed: 0
  };

  // Phase 1: Extract files
  onProgress?.({
    phase: 'extracting',
    current: 0,
    total: 0,
    currentFile: 'Starting extraction...'
  });

  const extractResult = await extractByPattern(ggpkPath, outputDir, pattern, {
    excludeLanguages,
    convertDDS: false, // We'll handle this ourselves
    onProgress
  });

  result.extracted = extractResult.extracted;

  // Phase 2: Post-process extracted files
  if (extractResult.extracted > 0) {
    // Find all files that need processing
    const ddsFiles: string[] = [];
    const datFiles: string[] = [];
    
    await scanDirectory(outputDir, (filePath) => {
      const ext = extname(filePath).toLowerCase();
      if (ext === '.dds') ddsFiles.push(filePath);
      if (ext === '.datc64' || ext === '.dat') datFiles.push(filePath);
    });

    // Convert DDS to WebP
    if (convertImages && ddsFiles.length > 0) {
      onProgress?.({
        phase: 'extracting',
        current: 0,
        total: ddsFiles.length,
        currentFile: `Converting ${ddsFiles.length} DDS files to WebP...`
      });

      for (let i = 0; i < ddsFiles.length; i++) {
        const file = ddsFiles[i];
        onProgress?.({
          phase: 'extracting',
          current: i + 1,
          total: ddsFiles.length,
          currentFile: `Converting: ${basename(file)}`
        });

        const success = await convertDDStoWebP(file, {
          deleteOriginal: true,
          quality: 90,
          skipExisting: true
        });

        if (success) {
          result.images.converted++;
        } else {
          result.images.failed++;
        }
      }
    }

    // Parse DAT to JSON
    if (parseDatFiles && datFiles.length > 0) {
      onProgress?.({
        phase: 'extracting',
        current: 0,
        total: datFiles.length,
        currentFile: `Parsing ${datFiles.length} DAT files to JSON...`
      });

      // Load schema and create parser
      let parser: DATParser | null = null;
      try {
        if (existsSync(schemaPath)) {
          const schema = await DATParser.loadSchema(schemaPath);
          parser = new DATParser(schema, true);
        }
      } catch (e) {
        console.warn('Could not load schema:', e);
      }

      for (let i = 0; i < datFiles.length; i++) {
        const file = datFiles[i];
        const tableName = basename(file).replace(/\.datc?64$/i, '').toLowerCase();
        
        onProgress?.({
          phase: 'extracting',
          current: i + 1,
          total: datFiles.length,
          currentFile: `Parsing: ${tableName}`
        });

        try {
          if (parser) {
            const buffer = Buffer.from(await Bun.file(file).arrayBuffer());
            const parsed = parser.parse(buffer, tableName);
            
            if (parsed && parsed.rows && parsed.rows.length > 0) {
              // Write JSON next to the DAT file
              const jsonPath = file.replace(/\.datc?64$/i, '.json');
              await writeFile(jsonPath, JSON.stringify(parsed, null, 2));
              
              // Delete original DAT file
              try {
                await unlink(file);
              } catch {}
              
              result.data.parsed++;
            } else {
              result.data.failed++;
            }
          } else {
            result.data.failed++;
          }
        } catch (e) {
          result.data.failed++;
        }
      }
    }
  }

  result.elapsed = Date.now() - startTime;

  onProgress?.({
    phase: 'done',
    current: result.extracted,
    total: result.extracted,
    elapsed: result.elapsed
  });

  return result;
}

/**
 * Recursively scan directory and call callback for each file
 */
async function scanDirectory(dir: string, onFile: (path: string) => void): Promise<void> {
  if (!existsSync(dir)) return;
  
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDirectory(fullPath, onFile);
      } else {
        onFile(fullPath);
      }
    }
  } catch {}
}

/**
 * Clean up converted files (remove DDS after WebP exists, remove DAT after JSON exists)
 */
export async function cleanupExtractedFiles(dir: string): Promise<{ dds: number; dat: number }> {
  let ddsRemoved = 0;
  let datRemoved = 0;

  await scanDirectory(dir, async (filePath) => {
    const ext = extname(filePath).toLowerCase();
    
    // Remove DDS if WebP exists
    if (ext === '.dds') {
      const webpPath = filePath.replace(/\.dds$/i, '.webp');
      if (existsSync(webpPath)) {
        try {
          await unlink(filePath);
          ddsRemoved++;
        } catch {}
      }
    }
    
    // Remove DAT if JSON exists
    if (ext === '.datc64' || ext === '.dat') {
      const jsonPath = filePath.replace(/\.datc?64$/i, '.json');
      if (existsSync(jsonPath)) {
        try {
          await unlink(filePath);
          datRemoved++;
        } catch {}
      }
    }
  });

  return { dds: ddsRemoved, dat: datRemoved };
}

// Extraction presets for common use cases
export const EXTRACTION_PRESETS = {
  all: {
    pattern: '.*',
    description: 'All files'
  },
  data: {
    pattern: '.*\\.datc?64$',
    description: 'Game data tables (.datc64)'
  },
  textures: {
    pattern: '.*\\.dds$',
    description: 'Textures (.dds → .webp)'
  },
  audio: {
    pattern: '.*\\.(ogg|wav)$',
    description: 'Audio files'
  },
  ui: {
    pattern: '^art/2dart/.*',
    description: 'UI artwork'
  },
  items: {
    pattern: '^art/2ditems/.*',
    description: 'Item icons'
  },
  skills: {
    pattern: '^art/2dart/skillicons/.*',
    description: 'Skill icons'
  },
  passives: {
    pattern: '^art/2dart/skillicons/passives/.*',
    description: 'Passive skill icons'
  }
};
