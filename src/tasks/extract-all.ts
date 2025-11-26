// Extract all assets from GGPK
import { GGPKReader } from '../ggpk/ggpk-reader';
import { getGGPKPath, Config } from '../config';
import { logger } from '../utils/logger';
import { join } from 'path';

interface ExtractionOptions {
  patterns?: string[];
  outputDir: string;
  includeAll?: boolean;
}

export async function extractAll(config: Config, options: ExtractionOptions): Promise<void> {
  logger.section('Extracting All Assets from GGPK');
  
  const ggpkPath = getGGPKPath(config);
  logger.info(`Reading GGPK: ${ggpkPath}`);
  
  const reader = new GGPKReader(ggpkPath);
  
  try {
    logger.step(1, 3, 'Building complete file index...');
    const index = await reader.buildIndex();
    
    logger.info(`Found ${index.size} files in GGPK`);
  
  if (options.includeAll) {
    logger.step(2, 3, 'Extracting ALL files (this may take a while)...');
    
    let extracted = 0;
    let failed = 0;
    
    for (const [filePath, fileRecord] of index) {
      const outputPath = join(options.outputDir, filePath);
      try {
        reader.extractFile(fileRecord, outputPath);
        extracted++;
        
        if (extracted % 100 === 0) {
          logger.info(`  Extracted ${extracted}/${index.size} files...`);
        }
      } catch (error) {
        failed++;
        if (failed < 10) {
          logger.warn(`  Failed: ${filePath}`);
        }
      }
    }
    
    logger.step(3, 3, 'Extraction complete!');
    logger.success(`Successfully extracted ${extracted} files`);
    if (failed > 0) {
      logger.warn(`Failed to extract ${failed} files`);
    }
  } else if (options.patterns && options.patterns.length > 0) {
    logger.step(2, 3, 'Extracting files matching patterns...');
    
    const regexes = options.patterns.map(p => 
      new RegExp(p.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i')
    );
    
    let extracted = 0;
    
    for (const [filePath, fileRecord] of index) {
      if (regexes.some(regex => regex.test(filePath))) {
        const outputPath = join(options.outputDir, filePath);
        try {
          reader.extractFile(fileRecord, outputPath);
          extracted++;
        } catch (error) {
          logger.warn(`  Failed: ${filePath}`);
        }
      }
    }
    
    logger.step(3, 3, 'Extraction complete!');
    logger.success(`Extracted ${extracted} files`);
  }
  } finally {
    // Always close the file handle to free resources
    reader.close();
  }
}
/**
 * Extract specific categories of assets
 */
export async function extractCategory(category: string, config: Config): Promise<void> {
  const categories: Record<string, { patterns: string[]; description: string }> = {
    'metadata': {
      patterns: ['Metadata/.*'],
      description: 'All game metadata files'
    },
    'data': {
      patterns: ['Data/.*\\.dat'],
      description: 'All .dat data files'
    },
    'images': {
      patterns: ['Art/.*\\.(dds|png)'],
      description: 'All image files (DDS and PNG)'
    },
    'ui': {
      patterns: ['Art/2DArt/UIImages/.*'],
      description: 'All UI images'
    },
    'audio': {
      patterns: ['Audio/.*'],
      description: 'All audio files'
    },
    'models': {
      patterns: ['Art/.*\\.(sm|fmt|ao)'],
      description: 'All 3D models'
    },
    'shaders': {
      patterns: ['Shaders/.*'],
      description: 'All shader files'
    },
    'animations': {
      patterns: ['Animations/.*'],
      description: 'All animation files'
    }
  };
  
  const categoryInfo = categories[category.toLowerCase()];
  
  if (!categoryInfo) {
    logger.error(`Unknown category: ${category}`);
    logger.info('Available categories:');
    for (const [name, info] of Object.entries(categories)) {
      logger.info(`  ${name}: ${info.description}`);
    }
    throw new Error(`Unknown category: ${category}`);
  }
  
  logger.section(`Extracting Category: ${category}`);
  logger.info(categoryInfo.description);
  
  await extractAll(config, {
    patterns: categoryInfo.patterns,
    outputDir: join(config.outputDir, category)
  });
}
