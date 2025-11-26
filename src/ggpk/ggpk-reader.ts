// GGPK File Format Parser
// Implements reading of Path of Exile's GGPK archive format
// Optimized for large files (100GB+) using positioned reads

import { openSync, readSync, closeSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { mkdirSync } from 'fs';

export interface GGPKHeader {
  magic: string;
  version: number;
  firstRecordOffset: bigint;
}

export interface FileRecord {
  type: 'FILE';
  offset: bigint;
  length: number;
  name: string;
  hash: Buffer;
  dataOffset: bigint;
  dataLength: number;
}

export interface DirectoryRecord {
  type: 'PDIR';
  offset: bigint;
  length: number;
  name: string;
  hash: Buffer;
  entries: bigint[];
}

export interface FreeRecord {
  type: 'FREE';
  offset: bigint;
  length: number;
  nextFreeOffset: bigint;
}

export type Record = FileRecord | DirectoryRecord | FreeRecord;

export class GGPKReader {
  private fd: number;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    // Open file handle once, keep it open for efficient random access
    this.fd = openSync(filePath, 'r');
  }

  /**
   * Read bytes from file at specific offset without loading entire file into memory.
   * Uses positioned read (pread) for efficient random access on large files.
   */
  private readAtOffset(offset: bigint, length: number): Buffer {
    const buffer = Buffer.alloc(length);
    // readSync with position parameter does a positioned read (pread)
    // This reads directly from the offset without seeking or loading the whole file
    readSync(this.fd, buffer, 0, length, Number(offset));
    return buffer;
  }

  /**
   * Close the file handle when done. Call this to free resources.
   */
  close(): void {
    if (this.fd !== -1) {
      closeSync(this.fd);
      this.fd = -1;
    }
  }

  readHeader(): GGPKHeader {
    // GGPK files start with a GGPK record (not raw header)
    // Format: [length:u32][tag:4bytes][version:u32][offsets:u64*2]
    const headerBuffer = this.readAtOffset(0n, 32);
    
    const recordLength = headerBuffer.readUInt32LE(0);
    const magic = headerBuffer.toString('utf8', 4, 8);
    
    if (magic !== 'GGPK') {
      throw new Error(`Invalid GGPK file: magic is "${magic}", expected "GGPK"`);
    }

    const version = headerBuffer.readUInt32LE(8);
    // The GGPK record contains offsets to the first two records (usually ROOT dir and a FREE record)
    const firstRecordOffset = headerBuffer.readBigUInt64LE(12);

    return { magic, version, firstRecordOffset };
  }

  readRecord(offset: bigint): Record {
    // Read record header (length + tag)
    const headerBuffer = this.readAtOffset(offset, 8);
    const length = headerBuffer.readUInt32LE(0);
    const tag = headerBuffer.toString('utf8', 4, 8);

    // Sanity check on length
    if (length < 8) {
      throw new Error(`Invalid record length ${length} at offset ${offset} (tag: ${tag})`);
    }

    switch (tag) {
      case 'FILE':
        // For FILE records, only read the metadata header, not the full content
        // This is critical for large files (videos can be 600MB+)
        return this.parseFileRecordLazy(offset, length);
      case 'PDIR':
        // Directory records are small, read entirely
        const pdirBuffer = this.readAtOffset(offset, length);
        return this.parseDirectoryRecord(offset, pdirBuffer);
      case 'FREE':
        const freeBuffer = this.readAtOffset(offset, Math.min(length, 24)); // Only need header
        return this.parseFreeRecord(offset, freeBuffer, length);
      default:
        throw new Error(`Unknown record type: "${tag}" at offset ${offset}`);
    }
  }

  /**
   * Parse FILE record without loading file content into memory.
   * Only reads the metadata header to get name and calculate data offset.
   */
  private parseFileRecordLazy(offset: bigint, totalLength: number): FileRecord {
    // FILE record structure:
    // [length:4][tag:4][nameLength:4][hash:32][name:nameLength*2][data:remaining]
    
    // Read enough to get nameLength
    const metaHeader = this.readAtOffset(offset, 16);
    const nameLength = metaHeader.readUInt32LE(8);
    
    // Now read the full header (without data)
    const headerSize = 8 + 4 + 32 + nameLength * 2; // tag+length + nameLen + hash + name
    const headerBuffer = this.readAtOffset(offset, headerSize);
    
    let pos = 8; // Skip length + tag
    pos += 4; // Skip nameLength (we already have it)
    
    const hash = headerBuffer.slice(pos, pos + 32);
    pos += 32;

    // Name is UTF-16LE (nameLength includes null terminator)
    const nameBuffer = headerBuffer.slice(pos, pos + (nameLength - 1) * 2);
    const name = nameBuffer.toString('utf16le');
    pos += nameLength * 2; // Skip full name including null terminator

    // Calculate data offset and length without reading content
    const dataOffset = offset + BigInt(pos);
    const dataLength = totalLength - pos;

    return {
      type: 'FILE',
      offset,
      length: totalLength,
      name,
      hash,
      dataOffset,
      dataLength,
    };
  }

  private parseFileRecord(offset: bigint, buffer: Buffer): FileRecord {
    let pos = 8; // Skip length + tag

    const nameLength = buffer.readUInt32LE(pos);
    pos += 4;

    const hash = buffer.slice(pos, pos + 32);
    pos += 32;

    // Name is UTF-16LE (nameLength includes null terminator)
    const nameBuffer = buffer.slice(pos, pos + (nameLength - 1) * 2);
    const name = nameBuffer.toString('utf16le');
    pos += nameLength * 2; // Skip full name including null terminator

    // Rest is file data
    const dataOffset = offset + BigInt(pos);
    const dataLength = buffer.length - pos;

    return {
      type: 'FILE',
      offset,
      length: buffer.length,
      name,
      hash,
      dataOffset,
      dataLength,
    };
  }

  private parseDirectoryRecord(offset: bigint, buffer: Buffer): DirectoryRecord {
    let pos = 8; // Skip length + tag

    const nameLength = buffer.readUInt32LE(pos);
    pos += 4;

    const entriesCount = buffer.readUInt32LE(pos);
    pos += 4;

    const hash = buffer.slice(pos, pos + 32);
    pos += 32;

    // Name is UTF-16LE (nameLength includes null terminator)
    const nameBuffer = buffer.slice(pos, pos + (nameLength - 1) * 2);
    const name = nameBuffer.toString('utf16le');
    pos += nameLength * 2; // Skip full name including null terminator

    // Read entries - each entry is: nameHash (4 bytes) + offset (8 bytes) = 12 bytes
    const entries: bigint[] = [];
    for (let i = 0; i < entriesCount; i++) {
      // Skip nameHash (4 bytes), read offset (8 bytes)
      pos += 4; // nameHash
      entries.push(buffer.readBigInt64LE(pos));
      pos += 8;
    }

    return {
      type: 'PDIR',
      offset,
      length: buffer.length,
      name,
      hash,
      entries,
    };
  }

  private parseFreeRecord(offset: bigint, buffer: Buffer, recordLength: number): FreeRecord {
    const nextFreeOffset = buffer.readBigUInt64LE(8);

    return {
      type: 'FREE',
      offset,
      length: recordLength,
      nextFreeOffset,
    };
  }

  extractFile(fileRecord: FileRecord, outputPath: string): void {
    // Create directory if needed
    const dir = dirname(outputPath);
    mkdirSync(dir, { recursive: true });

    // For large files (>50MB), use chunked reading to avoid memory spikes
    const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks
    
    if (fileRecord.dataLength > CHUNK_SIZE) {
      // Stream large files in chunks
      const { openSync: openWrite, writeSync, closeSync: closeWrite } = require('fs');
      const outFd = openWrite(outputPath, 'w');
      
      let remaining = fileRecord.dataLength;
      let currentOffset = fileRecord.dataOffset;
      
      while (remaining > 0) {
        const chunkSize = Math.min(CHUNK_SIZE, remaining);
        const chunk = this.readAtOffset(currentOffset, chunkSize);
        writeSync(outFd, chunk);
        currentOffset += BigInt(chunkSize);
        remaining -= chunkSize;
      }
      
      closeWrite(outFd);
    } else {
      // Small files: read entire file at once
      const data = this.readAtOffset(fileRecord.dataOffset, fileRecord.dataLength);
      writeFileSync(outputPath, data);
    }
  }

  async buildIndex(): Promise<Map<string, FileRecord>> {
    const index = new Map<string, FileRecord>();
    const header = this.readHeader();

    console.log(`GGPK version: ${header.version}`);
    console.log(`First record at: ${header.firstRecordOffset}`);

    const traverse = (offset: bigint, path: string = ''): void => {
      try {
        const record = this.readRecord(offset);

        if (record.type === 'PDIR') {
          const dirPath = path ? `${path}/${record.name}` : record.name;
          
          // Skip ROOT entry name for cleaner paths
          const cleanPath = record.name === 'ROOT' ? '' : dirPath;
          
          for (const entryOffset of record.entries) {
            traverse(entryOffset, cleanPath);
          }
        } else if (record.type === 'FILE') {
          const filePath = path ? `${path}/${record.name}` : record.name;
          index.set(filePath, record);
        }
        // Ignore FREE records
      } catch (error) {
        console.error(`Error reading record at ${offset}:`, error);
      }
    };

    traverse(header.firstRecordOffset);
    
    console.log(`Indexed ${index.size} files`);
    return index;
  }

  listFiles(pattern?: RegExp): string[] {
    const index = new Map<string, FileRecord>();
    const header = this.readHeader();
    const files: string[] = [];

    const traverse = (offset: bigint, path: string = ''): void => {
      try {
        const record = this.readRecord(offset);

        if (record.type === 'PDIR') {
          const dirPath = path ? `${path}/${record.name}` : record.name;
          const cleanPath = record.name === 'ROOT' ? '' : dirPath;
          
          for (const entryOffset of record.entries) {
            traverse(entryOffset, cleanPath);
          }
        } else if (record.type === 'FILE') {
          const filePath = path ? `${path}/${record.name}` : record.name;
          if (!pattern || pattern.test(filePath)) {
            files.push(filePath);
          }
        }
      } catch (error) {
        // Ignore errors during listing
      }
    };

    traverse(header.firstRecordOffset);
    return files;
  }
}
