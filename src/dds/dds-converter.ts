// DDS Texture Converter
// Converts DDS textures to PNG/WebP using sharp

import sharp from 'sharp';
import { readFileSync } from 'fs';

export interface DDSInfo {
  width: number;
  height: number;
  format: string;
  mipmapCount: number;
}

export class DDSConverter {
  /**
   * Parse DDS header to get image info
   */
  parseDDSHeader(buffer: Buffer): DDSInfo {
    // DDS file structure:
    // DDS Header offsets
    // 0-3: Magic "DDS ", 4-7: Size (124), 8-11: Flags
    // 12-15: Height, 16-19: Width, 28: MipmapCount
    
    const magic = buffer.toString('ascii', 0, 4);
    if (magic !== 'DDS ') {
      throw new Error('Not a valid DDS file');
    }

    const height = buffer.readUInt32LE(12);
    const width = buffer.readUInt32LE(16);
    const mipmapCount = buffer.readUInt32LE(28);
    
    // Read pixel format (at offset 84)
    const fourCC = buffer.toString('ascii', 84, 88);
    
    return {
      width,
      height,
      format: fourCC,
      mipmapCount: mipmapCount || 1,
    };
  }

  /**
   * Convert DDS to PNG
   * Note: This is simplified - full DDS support requires proper decompression
   * For now, we try to extract what we can with sharp
   */
  async convertToPNG(ddsPath: string, outputPath: string): Promise<void> {
    try {
      const buffer = readFileSync(ddsPath);
      const info = this.parseDDSHeader(buffer);
      
      console.log(`Converting ${ddsPath}: ${info.width}x${info.height} ${info.format}`);
      
      // DDS header is 128 bytes, pixel data starts after
      const pixelDataOffset = 128;
      const pixelData = buffer.slice(pixelDataOffset);
      
      // Try to convert with sharp
      // This works for uncompressed DDS, but compressed formats need special handling
      try {
        await sharp(pixelData, {
          raw: {
            width: info.width,
            height: info.height,
            channels: 4, // RGBA
          }
        })
          .png()
          .toFile(outputPath);
      } catch (error) {
        // If sharp fails, we need specialized DDS decoder
        // For now, just copy the file and log warning
        console.warn(`Could not convert ${ddsPath}: ${error}`);
        console.warn('This DDS file may need specialized decoder for format:', info.format);
        throw error;
      }
    } catch (error) {
      throw new Error(`Failed to convert DDS: ${error}`);
    }
  }

  /**
   * Convert DDS to WebP
   */
  async convertToWebP(ddsPath: string, outputPath: string, quality: number = 85): Promise<void> {
    try {
      const buffer = readFileSync(ddsPath);
      const info = this.parseDDSHeader(buffer);
      
      const pixelDataOffset = 128;
      const pixelData = buffer.slice(pixelDataOffset);
      
      await sharp(pixelData, {
        raw: {
          width: info.width,
          height: info.height,
          channels: 4,
        }
      })
        .webp({ quality })
        .toFile(outputPath);
    } catch (error) {
      throw new Error(`Failed to convert DDS to WebP: ${error}`);
    }
  }

  /**
   * Extract raw RGBA data from DDS
   * Returns a Buffer with RGBA pixel data
   */
  async extractRGBA(ddsPath: string): Promise<{ data: Buffer; width: number; height: number }> {
    const buffer = readFileSync(ddsPath);
    const info = this.parseDDSHeader(buffer);
    
    const pixelDataOffset = 128;
    const pixelData = buffer.slice(pixelDataOffset);
    
    // For simple formats, pixel data might already be RGBA
    // For compressed formats (DXT1, DXT5, BC7), we'd need decompression
    
    return {
      data: pixelData,
      width: info.width,
      height: info.height,
    };
  }
}

/**
 * Batch convert DDS files
 */
export async function batchConvertDDS(
  inputPaths: string[],
  outputDir: string,
  format: 'png' | 'webp' = 'png'
): Promise<void> {
  const converter = new DDSConverter();
  
  for (const inputPath of inputPaths) {
    try {
      const outputPath = inputPath
        .replace(/\.dds$/i, `.${format}`)
        .replace(/^.*[\/\\]/, `${outputDir}/`);
      
      if (format === 'png') {
        await converter.convertToPNG(inputPath, outputPath);
      } else {
        await converter.convertToWebP(inputPath, outputPath);
      }
      
      console.log(`[+] Converted: ${inputPath}`);
    } catch (error) {
      console.error(`[x] Failed: ${inputPath}`, error);
    }
  }
}
