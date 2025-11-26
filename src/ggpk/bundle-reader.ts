// Bundle File Format Parser
// POE2 uses Bundle files (.bundle.bin) for packaged assets

import { readFileSync } from 'fs';
import * as pako from 'pako';

export interface BundleHeader {
  uncompressedSize: number;
  totalPayloadSize: number;
  headPayloadSize: number;
}

export interface BundleFileEntry {
  name: string;
  hash: bigint;
  offset: number;
  size: number;
}

export class BundleReader {
  private buffer: Buffer;
  private files: Map<string, BundleFileEntry> = new Map();
  private header: BundleHeader;

  constructor(bundlePath: string) {
    this.buffer = readFileSync(bundlePath);
    this.header = this.parseHeader();
    this.parseFileIndex();
  }

  private parseHeader(): BundleHeader {
    const uncompressedSize = this.buffer.readUInt32LE(0);
    const totalPayloadSize = this.buffer.readUInt32LE(4);
    const headPayloadSize = this.buffer.readUInt32LE(8);

    return {
      uncompressedSize,
      totalPayloadSize,
      headPayloadSize,
    };
  }

  private parseFileIndex(): void {
    // Read and decompress first block (contains file index)
    const firstBlockOffset = 12; // After header
    const compressed = this.buffer.slice(firstBlockOffset, firstBlockOffset + this.header.headPayloadSize);
    
    try {
      const decompressed = pako.inflate(compressed);
      const indexBuffer = Buffer.from(decompressed);
      
      // Parse file entries from index
      // This is a simplified parser - actual format may vary
      let offset = 0;
      const fileCount = indexBuffer.readUInt32LE(offset);
      offset += 4;

      for (let i = 0; i < fileCount && offset < indexBuffer.length - 16; i++) {
        try {
          const nameLength = indexBuffer.readUInt32LE(offset);
          offset += 4;

          if (nameLength > 0 && nameLength < 1000 && offset + nameLength < indexBuffer.length) {
            const name = indexBuffer.toString('utf8', offset, offset + nameLength);
            offset += nameLength;

            const hash = indexBuffer.readBigUInt64LE(offset);
            offset += 8;

            const fileOffset = indexBuffer.readUInt32LE(offset);
            offset += 4;

            const size = indexBuffer.readUInt32LE(offset);
            offset += 4;

            this.files.set(name, { name, hash, offset: fileOffset, size });
          } else {
            break;
          }
        } catch (e) {
          break;
        }
      }
    } catch (error) {
      console.warn('Failed to parse bundle index:', error);
    }
  }

  private decompressBlock(offset: number, size: number): Buffer {
    const compressed = this.buffer.slice(offset, offset + size);
    
    try {
      // Try pako inflate (zlib/deflate)
      const decompressed = pako.inflate(compressed);
      return Buffer.from(decompressed);
    } catch (error) {
      // If inflate fails, might be uncompressed or different format
      console.warn('Decompression failed, returning raw data');
      return compressed;
    }
  }

  extractFile(fileName: string): Buffer | null {
    const entry = this.files.get(fileName);
    if (!entry) {
      return null;
    }

    try {
      return this.decompressBlock(entry.offset, entry.size);
    } catch (error) {
      console.error(`Failed to extract ${fileName}:`, error);
      return null;
    }
  }

  listFiles(): string[] {
    return Array.from(this.files.keys());
  }

  getFileCount(): number {
    return this.files.size;
  }
}
