// Extract files from GGPK
import { GGPKReader } from '../ggpk/ggpk-reader';
import { getGGPKPath, Config } from '../config';
import { logger } from '../utils/logger';
import { join } from 'path';

export async function extractFiles(patterns: string[], outputDir: string, config: Config): Promise<void> {
  logger.section('Extracting Files from GGPK');
  
  const ggpkPath = getGGPKPath(config);
  logger.info(`Reading GGPK: ${ggpkPath}`);
  
  const reader = new GGPKReader(ggpkPath);
  const index = await reader.buildIndex();
  
  let extractedCount = 0;
  
  for (const pattern of patterns) {
    logger.step(patterns.indexOf(pattern) + 1, patterns.length, `Extracting: ${pattern}`);
    
    // Convert glob pattern to regex
    const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');
    
    for (const [filePath, fileRecord] of index) {
      if (regex.test(filePath)) {
        const outputPath = join(outputDir, filePath);
        try {
          reader.extractFile(fileRecord, outputPath);
          extractedCount++;
        } catch (error) {
          logger.error(`Failed to extract ${filePath}:`, error);
        }
      }
    }
  }
  
  logger.success(`Extracted ${extractedCount} files to ${outputDir}`);
}

export async function listFiles(pattern: string, config: Config): Promise<string[]> {
  const ggpkPath = getGGPKPath(config);
  const reader = new GGPKReader(ggpkPath);
  
  // Convert glob pattern to regex
  const regex = pattern === '**/*' 
    ? /.*/ 
    : new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');
  
  return reader.listFiles(regex);
}
