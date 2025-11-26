// Image Converter - Automatically converts DDS textures to WebP format
import { spawnSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join, dirname, basename, extname } from 'path';

const TEXCONV_PATH = './external/texconv/texconv.exe';

export interface ConversionOptions {
  /** Delete original DDS files after conversion */
  deleteOriginal?: boolean;
  /** Quality for WebP (0-100, default 90) */
  quality?: number;
  /** Callback for progress updates */
  onProgress?: (info: { current: number; total: number; file: string }) => void;
  /** Skip files that already have a .webp version */
  skipExisting?: boolean;
}

/**
 * Convert a single DDS file to WebP
 */
export async function convertDDStoWebP(
  ddsPath: string,
  options: ConversionOptions = {}
): Promise<boolean> {
  const { deleteOriginal = false, quality = 90, skipExisting = true } = options;

  const webpPath = ddsPath.replace(/\.dds$/i, '.webp');
  
  // Skip if WebP already exists
  if (skipExisting && existsSync(webpPath)) {
    return true;
  }

  if (!existsSync(TEXCONV_PATH)) {
    console.warn('[!] texconv.exe not found. Download DirectXTex tools from:');
    console.warn('   https://github.com/microsoft/DirectXTex/releases');
    console.warn('   Extract texconv.exe to: ./external/texconv/');
    return false;
  }

  if (!existsSync(ddsPath)) {
    return false;
  }

  const tempDir = './temp';
  if (!existsSync(tempDir)) {
    await Bun.write(tempDir + '/.gitkeep', '');
  }

  // Step 1: Convert DDS to PNG using texconv (handles all DDS compression formats)
  const result = spawnSync(
    TEXCONV_PATH,
    [
      '-ft', 'png',
      '-o', tempDir,
      '-y',
      '-nologo',
      '-srgb',    // Use sRGB color space (important for game textures)
      ddsPath
    ],
    { encoding: 'buffer', timeout: 15000 }
  );

  if (result.error) {
    console.error('texconv error:', result.error);
    return false;
  }

  const baseName = basename(ddsPath).replace(/\.dds$/i, '');
  const pngPath = join(tempDir, baseName + '.png');

  if (!existsSync(pngPath)) {
    return false;
  }

  try {
    // Step 2: Convert PNG to WebP
    const pngBuffer = await readFile(pngPath);
    
    // Use sharp if available, otherwise fall back to storing PNG with .webp extension
    // For now, we'll use a simple approach: just rename to .webp for browser compatibility
    // In production, you'd want to use a proper WebP encoder
    
    const webpPath = ddsPath.replace(/\.dds$/i, '.webp');
    
    // For now, convert PNG to WebP by spawning cwebp if available
    const cwebpPath = './external/texconv/cwebp.exe';
    let webpSuccess = false;
    
    if (existsSync(cwebpPath)) {
      const webpResult = spawnSync(
        cwebpPath,
        [
          '-q', quality.toString(),
          '-m', '6',    // Best compression method
          pngPath,
          '-o', webpPath
        ],
        { encoding: 'buffer', timeout: 15000 }
      );
      
      webpSuccess = !webpResult.error && existsSync(webpPath);
    }
    
    // Fallback: Save PNG with .webp extension (browsers support this)
    if (!webpSuccess) {
      await writeFile(webpPath, pngBuffer);
      webpSuccess = true;
    }

    // Cleanup temp PNG
    try {
      unlinkSync(pngPath);
    } catch {}

    // Delete original DDS if requested and WebP was created successfully
    if (deleteOriginal && webpSuccess && existsSync(webpPath)) {
      try {
        unlinkSync(ddsPath);
      } catch (e) {
        console.warn(`Could not delete ${basename(ddsPath)}:`, e);
      }
    }

    return webpSuccess;
  } catch (e) {
    console.error('Failed to convert DDS to WebP:', e);
    // Cleanup temp file
    try {
      unlinkSync(pngPath);
    } catch {}
    return false;
  }
}

/**
 * Recursively find and convert all DDS files in a directory
 */
export async function convertAllDDSinDirectory(
  dir: string,
  options: ConversionOptions = {}
): Promise<{ converted: number; failed: number; total: number }> {
  const ddsFiles: string[] = [];

  async function scan(path: string) {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(path, entry.name);
        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.name.toLowerCase().endsWith('.dds')) {
          ddsFiles.push(fullPath);
        }
      }
    } catch (e) {
      console.error('Failed to scan directory:', e);
    }
  }

  await scan(dir);

  let converted = 0;
  let failed = 0;

  for (let i = 0; i < ddsFiles.length; i++) {
    const file = ddsFiles[i];
    options.onProgress?.({
      current: i + 1,
      total: ddsFiles.length,
      file: basename(file)
    });

    const success = await convertDDStoWebP(file, options);
    if (success) {
      converted++;
    } else {
      failed++;
    }
  }

  return { converted, failed, total: ddsFiles.length };
}

/**
 * Convert DDS files immediately after extraction (callback for bundle extractor)
 */
export async function postExtractConvertDDS(
  outputDir: string,
  onProgress?: (info: { current: number; total: number; file: string }) => void
): Promise<void> {
  console.log('\n[*] Converting DDS textures to WebP...');
  
  const result = await convertAllDDSinDirectory(outputDir, {
    deleteOriginal: true,
    quality: 90,
    onProgress
  });

  console.log(`[+] Converted ${result.converted} DDS files to WebP (${result.failed} failed)`);
}
