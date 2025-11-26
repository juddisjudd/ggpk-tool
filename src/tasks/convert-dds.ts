// Convert DDS files to PNG/WebP
import { DDSConverter } from '../dds/dds-converter';
import { logger } from '../utils/logger';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { Config } from '../config';

export async function convertDDS(
  inputPath: string,
  outputPath: string,
  format: 'png' | 'webp',
  config: Config
): Promise<void> {
  logger.section('Converting DDS Files');
  
  const converter = new DDSConverter();
  
  // Check if input is file or directory
  const stat = statSync(inputPath);
  
  if (stat.isFile()) {
    // Convert single file
    logger.info(`Converting: ${inputPath}`);
    
    if (format === 'png') {
      await converter.convertToPNG(inputPath, outputPath);
    } else {
      await converter.convertToWebP(inputPath, outputPath, config.conversion?.dds?.quality || 85);
    }
    
    logger.success(`Converted to: ${outputPath}`);
  } else if (stat.isDirectory()) {
    // Convert directory
    logger.info(`Scanning directory: ${inputPath}`);
    
    const files = readdirSync(inputPath, { recursive: true });
    const ddsFiles = files
      .filter(f => typeof f === 'string' && f.toLowerCase().endsWith('.dds'))
      .map(f => join(inputPath, f as string));
    
    logger.info(`Found ${ddsFiles.length} DDS files`);
    
    for (let i = 0; i < ddsFiles.length; i++) {
      const ddsFile = ddsFiles[i];
      const relativePath = ddsFile.replace(inputPath, '');
      const outFile = join(outputPath, relativePath.replace(/\.dds$/i, `.${format}`));
      
      logger.step(i + 1, ddsFiles.length, `Converting ${relativePath}`);
      
      try {
        if (format === 'png') {
          await converter.convertToPNG(ddsFile, outFile);
        } else {
          await converter.convertToWebP(ddsFile, outFile, config.conversion?.dds?.quality || 85);
        }
      } catch (error) {
        logger.warn(`Failed to convert ${relativePath}: ${error}`);
      }
    }
    
    logger.success(`Converted ${ddsFiles.length} files`);
  }
}
