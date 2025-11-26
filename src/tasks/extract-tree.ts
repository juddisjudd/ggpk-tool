// Extract passive tree assets
import { GGPKReader } from '../ggpk/ggpk-reader';
import { getGGPKPath, Config } from '../config';
import { logger } from '../utils/logger';
import { join } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

interface TreeExtractionConfig extends Config {
  treeVersion: string;
  copyToApp: boolean;
}

export async function extractTree(config: TreeExtractionConfig): Promise<void> {
  logger.section(`Extracting Passive Tree Assets (Version: ${config.treeVersion})`);
  
  const ggpkPath = getGGPKPath(config);
  logger.info(`Reading GGPK: ${ggpkPath}`);
  
  const reader = new GGPKReader(ggpkPath);
  logger.step(1, 4, 'Building file index...');
  const index = await reader.buildIndex();
  
  // Files to extract
  const treeFiles = [
    // Tree data - these are typically in Metadata
    'Metadata/StatDescriptions/passive_skill_stat_descriptions.txt',
    'Metadata/StatDescriptions/stat_descriptions.txt',
    
    // Data files (might be in Data/ or similar)
    'Data/PassiveSkills.dat',
    'Data/PassiveSkillTrees.dat',
    'Data/PassiveTreeExpansionJewels.dat',
    'Data/PassiveTreeExpansionJewelSizes.dat',
  ];
  
  // Icon patterns
  const iconPatterns = [
    /PassiveSkill.*\.dds/i,
    /PassiveSkill.*\.png/i,
    /passive.*\.dds/i,
    /passive.*\.png/i,
  ];
  
  // Background patterns  
  const backgroundPatterns = [
    /background.*passive/i,
    /PSStartNodeBackgroundInactive/i,
    /Ascendancy.*Background/i,
  ];
  
  logger.step(2, 4, 'Extracting tree data files...');
  let extractedCount = 0;
  
  for (const filePath of treeFiles) {
    const fileRecord = index.get(filePath);
    if (fileRecord) {
      const outputPath = join(config.outputDir, 'tree', filePath);
      try {
        reader.extractFile(fileRecord, outputPath);
        logger.success(`  ${filePath}`);
        extractedCount++;
      } catch (error) {
        logger.warn(`  [x] ${filePath}: ${error}`);
      }
    } else {
      logger.warn(`  [!] Not found: ${filePath}`);
    }
  }
  
  logger.step(3, 4, 'Extracting icon files...');
  for (const [filePath, fileRecord] of index) {
    if (iconPatterns.some(pattern => pattern.test(filePath))) {
      const outputPath = join(config.outputDir, 'tree', 'icons', filePath);
      try {
        reader.extractFile(fileRecord, outputPath);
        extractedCount++;
      } catch (error) {
        // Silently fail for icons, there are many
      }
    }
  }
  logger.success(`  Extracted icon files`);
  
  logger.step(4, 4, 'Extracting background files...');
  for (const [filePath, fileRecord] of index) {
    if (backgroundPatterns.some(pattern => pattern.test(filePath))) {
      const outputPath = join(config.outputDir, 'tree', 'backgrounds', filePath);
      try {
        reader.extractFile(fileRecord, outputPath);
        extractedCount++;
      } catch (error) {
        // Silently fail
      }
    }
  }
  logger.success(`  Extracted background files`);
  
  logger.success(`\nTotal extracted: ${extractedCount} files`);
  logger.info(`Output directory: ${join(config.outputDir, 'tree')}`);
  
}
