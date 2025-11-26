// DAT File Parser for POE2 .datc64 files
// Based on poe-dat-viewer's implementation
// Optimized for Bun runtime

import * as path from 'path';
import { logger } from '../utils/logger';

// Schema types
interface SchemaColumn {
  name: string | null;
  description: string | null;
  array: boolean;
  type: 'bool' | 'i16' | 'i32' | 'u16' | 'u32' | 'f32' | 'string' | 'row' | 'foreignrow' | 'enumrow' | 'array';
  unique: boolean;
  localized: boolean;
  references: { table: string; column?: string } | null;
  until: string | null;
  file: string | null;
  files: string[] | null;
}

interface SchemaTable {
  validFor: number; // 1=POE1, 2=POE2, 3=both
  name: string;
  columns: SchemaColumn[];
}

interface Schema {
  version: number;
  createdAt: number;
  tables: SchemaTable[];
}

// Field sizes in bytes for datc64 format
const FIELD_SIZES: Record<string, number> = {
  bool: 1,
  i16: 2,
  u16: 2,
  i32: 4,
  u32: 4,
  f32: 4,
  string: 8, // offset in variable data
  row: 8, // self-referencing key (can be -1 for null)
  foreignrow: 16, // rid + unknown
  enumrow: 4, // enum value (i32)
  array: 16, // length + offset
};

// Null values
const NULL_ROW = -1n; // 0xFFFFFFFFFFFFFFFF
const NULL_FOREIGN_ROW = 0xFFFFFFFFFFFFFFFEn; // -2
const NULL_MARKER = BigInt.asIntN(64, 0xFEFEFEFEFEFEFEFEn); // 0xFEFEFEFEFEFEFEFE - another null marker

// Magic bytes separating fixed and variable data
const VARIABLE_DATA_MAGIC = Buffer.from([0xBB, 0xBB, 0xBB, 0xBB, 0xBB, 0xBB, 0xBB, 0xBB]);

export class DATParser {
  private schema: Schema;
  private tableMap: Map<string, SchemaTable>;
  private isPOE2: boolean;

  constructor(schema: Schema, isPOE2 = true) {
    this.schema = schema;
    this.isPOE2 = isPOE2;
    this.tableMap = new Map();
    
    // Build table map (case-insensitive)
    for (const table of schema.tables) {
      // Filter by game version
      const validForPOE2 = (table.validFor & 2) !== 0;
      const validForPOE1 = (table.validFor & 1) !== 0;
      
      if ((isPOE2 && validForPOE2) || (!isPOE2 && validForPOE1)) {
        this.tableMap.set(table.name.toLowerCase(), table);
      }
    }
  }

  /**
   * Load schema from JSON file (Bun-optimized)
   */
  static async loadSchema(schemaPath: string): Promise<Schema> {
    const file = Bun.file(schemaPath);
    return await file.json();
  }

  /**
   * Get table schema by name
   */
  getTableSchema(tableName: string): SchemaTable | undefined {
    return this.tableMap.get(tableName.toLowerCase());
  }

  /**
   * List all available tables
   */
  listTables(): string[] {
    return Array.from(this.tableMap.keys()).sort();
  }

  /**
   * Calculate fixed row size for a table
   */
  private calculateRowSize(table: SchemaTable): number {
    let size = 0;
    for (const col of table.columns) {
      if (col.array) {
        size += 16; // array is always length (8) + offset (8)
      } else {
        size += FIELD_SIZES[col.type] || 8;
      }
    }
    return size;
  }

  /**
   * Parse a .datc64 file
   */
  parse(buffer: Buffer, tableName: string): { rows: any[]; rowCount: number; error?: string } {
    const table = this.getTableSchema(tableName);
    if (!table) {
      return { rows: [], rowCount: 0, error: `Unknown table: ${tableName}` };
    }

    // Read row count (first 4 bytes)
    if (buffer.length < 4) {
      return { rows: [], rowCount: 0, error: 'Buffer too small' };
    }
    const rowCount = buffer.readUInt32LE(0);

    if (rowCount === 0) {
      return { rows: [], rowCount: 0 };
    }

    // Find variable data section (look for magic bytes)
    const fixedDataStart = 4;
    const magicIndex = buffer.indexOf(VARIABLE_DATA_MAGIC, fixedDataStart);
    
    if (magicIndex === -1) {
      return { rows: [], rowCount: 0, error: 'Magic bytes not found' };
    }
    
    // Variable data offsets are relative to magic bytes position (NOT after them!)
    const variableDataStart = magicIndex;
    
    // Calculate actual row size from data (more reliable than schema)
    const fixedDataLength = magicIndex - fixedDataStart;
    const actualRowSize = Math.floor(fixedDataLength / rowCount);
    
    // Calculate expected row size from schema
    const schemaRowSize = this.calculateRowSize(table);
    
    // Use actual row size if it differs from schema (schema may be outdated)
    const rowSize = actualRowSize;
    
    if (actualRowSize !== schemaRowSize) {
      // Schema mismatch - this is common with evolving schemas
      // We'll still try to parse, but might have issues
    }

    const rows: any[] = [];
    let offset = fixedDataStart;

    try {
      for (let i = 0; i < rowCount; i++) {
        const row: any = { _rid: i };
        const rowStart = offset;
        
        for (let colIdx = 0; colIdx < table.columns.length; colIdx++) {
          const col = table.columns[colIdx];
          const fieldName = col.name || `_unknown${colIdx}`;
          
          // Don't read past row boundary
          if (offset >= rowStart + rowSize) {
            break;
          }
          
          try {
            if (col.array) {
              const { value, bytesRead } = this.readArray(buffer, offset, variableDataStart, col.type);
              row[fieldName] = value;
              offset += bytesRead;
            } else {
              const { value, bytesRead } = this.readField(buffer, offset, variableDataStart, col.type);
              row[fieldName] = value;
              offset += bytesRead;
            }
          } catch (e) {
            row[fieldName] = null;
            offset += col.array ? 16 : (FIELD_SIZES[col.type] || 8);
          }
        }
        
        // Ensure we advance to next row even if schema is incomplete
        offset = rowStart + rowSize;
        rows.push(row);
      }
    } catch (e) {
      return { rows, rowCount, error: `Parse error at row ${rows.length}: ${e}` };
    }

    return { rows, rowCount };
  }

  /**
   * Read a single field value
   */
  private readField(
    buffer: Buffer,
    offset: number,
    variableDataStart: number,
    type: string
  ): { value: any; bytesRead: number } {
    switch (type) {
      case 'bool':
        return { value: buffer.readUInt8(offset) !== 0, bytesRead: 1 };

      case 'i16':
        return { value: buffer.readInt16LE(offset), bytesRead: 2 };

      case 'u16':
        return { value: buffer.readUInt16LE(offset), bytesRead: 2 };

      case 'i32':
      case 'enumrow':
        return { value: buffer.readInt32LE(offset), bytesRead: 4 };

      case 'u32':
        return { value: buffer.readUInt32LE(offset), bytesRead: 4 };

      case 'f32':
        return { value: buffer.readFloatLE(offset), bytesRead: 4 };

      case 'string': {
        const strOffset = buffer.readBigInt64LE(offset);
        if (strOffset < 0n) {
          return { value: null, bytesRead: 8 };
        }
        const str = this.readString(buffer, variableDataStart + Number(strOffset));
        return { value: str, bytesRead: 8 };
      }

      case 'row': {
        const rid = buffer.readBigInt64LE(offset);
        if (rid === NULL_ROW || rid === NULL_MARKER) {
          return { value: null, bytesRead: 8 };
        }
        return { value: Number(rid), bytesRead: 8 };
      }

      case 'foreignrow': {
        const rid = buffer.readBigInt64LE(offset);
        // const unknown = buffer.readBigInt64LE(offset + 8);
        if (rid === NULL_ROW || rid === NULL_FOREIGN_ROW || rid === NULL_MARKER) {
          return { value: null, bytesRead: 16 };
        }
        return { value: Number(rid), bytesRead: 16 };
      }

      default:
        // Unknown type, try to read as 8 bytes
        return { value: buffer.readBigInt64LE(offset).toString(), bytesRead: 8 };
    }
  }

  /**
   * Read an array field
   */
  private readArray(
    buffer: Buffer,
    offset: number,
    variableDataStart: number,
    elementType: string
  ): { value: any[]; bytesRead: number } {
    const length = buffer.readBigInt64LE(offset);
    const arrayOffset = buffer.readBigInt64LE(offset + 8);

    if (length === 0n || arrayOffset < 0n) {
      return { value: [], bytesRead: 16 };
    }

    const count = Number(length);
    
    // Sanity check: limit array size to prevent infinite loops
    // Also catch bad element types like "array" which don't make sense
    if (count > 100000 || count < 0) {
      return { value: [], bytesRead: 16 };
    }
    
    // Handle invalid element types (like "array" which is a schema error)
    if (elementType === 'array' || !FIELD_SIZES[elementType]) {
      // Try to guess - most arrays are i32 or foreignrow
      // Just return empty for invalid types
      return { value: [], bytesRead: 16 };
    }
    
    const dataOffset = variableDataStart + Number(arrayOffset);
    
    // Validate offset is within bounds
    if (dataOffset < 0 || dataOffset >= buffer.length) {
      return { value: [], bytesRead: 16 };
    }
    
    const values: any[] = [];
    
    let elementOffset = dataOffset;
    const elementSize = FIELD_SIZES[elementType] || 8;

    for (let i = 0; i < count; i++) {
      // Bounds check
      if (elementOffset + elementSize > buffer.length) {
        break;
      }
      
      try {
        const { value } = this.readField(buffer, elementOffset, variableDataStart, elementType);
        values.push(value);
        elementOffset += elementSize;
      } catch {
        values.push(null);
        elementOffset += elementSize;
      }
    }

    return { value: values, bytesRead: 16 };
  }

  /**
   * Read a UTF-16LE string from variable data
   */
  private readString(buffer: Buffer, offset: number): string {
    if (offset >= buffer.length) {
      return '';
    }

    // Find null terminator (4 bytes of zeros for UTF-16)
    let end = offset;
    while (end + 4 <= buffer.length) {
      // Check for 4-byte null terminator
      if (buffer.readUInt32LE(end) === 0) {
        break;
      }
      end += 2; // Move by UTF-16 character
    }

    if (end === offset) {
      return '';
    }

    try {
      return buffer.toString('utf16le', offset, end);
    } catch {
      return '';
    }
  }

  /**
   * Parse a .datc64 file from path (Bun-optimized)
   */
  async parseFile(filePath: string): Promise<{ rows: any[]; rowCount: number; tableName: string; error?: string }> {
    const arrayBuffer = await Bun.file(filePath).arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const baseName = path.basename(filePath, '.datc64');
    const tableName = baseName.replace(/^[^a-zA-Z]*/, ''); // Remove leading non-alpha chars
    
    const result = this.parse(buffer, tableName);
    return { ...result, tableName };
  }
}

export interface ParseAllOptions {
  filter?: string;
  pretty?: boolean;
  limit?: number;
  useCache?: boolean;
}

export interface ParseAllResult {
  success: number;
  failed: number;
  skipped: number;
  cached: number;
}

/**
 * Check if output file is newer than input (cached)
 */
async function isCached(inputPath: string, outputPath: string): Promise<boolean> {
  const fs = await import('fs');
  try {
    const [inputStat, outputStat] = await Promise.all([
      fs.promises.stat(inputPath),
      fs.promises.stat(outputPath).catch(() => null)
    ]);
    if (!outputStat) return false;
    return outputStat.mtimeMs >= inputStat.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Parse all .datc64 files in a directory
 */
export async function parseAllDatFiles(
  dataDir: string,
  outputDir: string,
  schemaPath: string,
  options: ParseAllOptions = {}
): Promise<ParseAllResult> {
  const fs = await import('fs');
  const fsp = fs.promises;
  const { readdir, mkdir } = fsp;
  
  // Load schema
  const schema = await DATParser.loadSchema(schemaPath);
  const parser = new DATParser(schema, true);
  
  logger.info(`Loaded schema v${schema.version} with ${parser.listTables().length} tables for POE2`);

  // Find all .datc64 files
  const files = await fsp.readdir(dataDir);
  let datFiles = files.filter(f => f.endsWith('.datc64'));
  
  if (options.filter) {
    const filterLower = options.filter.toLowerCase();
    datFiles = datFiles.filter(f => f.toLowerCase().includes(filterLower));
  }
  
  if (options.limit && options.limit > 0) {
    datFiles = datFiles.slice(0, options.limit);
  }

  logger.info(`Found ${datFiles.length} .datc64 files to parse`);

  // Ensure output dir exists
  await fsp.mkdir(outputDir, { recursive: true });

  let success = 0;
  let failed = 0;
  let skipped = 0;
  let cached = 0;
  const total = datFiles.length;
  const startTime = Date.now();

  for (let i = 0; i < datFiles.length; i++) {
    const file = datFiles[i];
    const tableName = file.replace('.datc64', '');
    const inputPath = path.join(dataDir, file);
    const outputPath = path.join(outputDir, `${tableName}.json`);

    // Progress indicator
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const percent = ((i / total) * 100).toFixed(0);
    process.stdout.write(`\r[${percent}%] ${i}/${total} files (${elapsed}s) - ${tableName.slice(0, 30).padEnd(30)}`);

    // Check if schema exists for this table
    if (!parser.getTableSchema(tableName)) {
      skipped++;
      continue;
    }

    // Check cache if enabled
    if (options.useCache !== false) {
      const skipCached = await isCached(inputPath, outputPath);
      if (skipCached) {
        cached++;
        success++;
        continue;
      }
    }

    try {
      // Bun-optimized: Bun.file() is 2x faster than fs.promises.readFile
      const arrayBuffer = await Bun.file(inputPath).arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const result = parser.parse(buffer, tableName);

      if (result.error) {
        process.stdout.write(`\n[!] Partial: ${tableName}: ${result.error}\n`);
      }

      const json = options.pretty
        ? JSON.stringify(result.rows, null, 2)
        : JSON.stringify(result.rows);
      
      // Bun-optimized: Bun.write() is faster than fs.promises.writeFile
      await Bun.write(outputPath, json);
      success++;
    } catch (e) {
      process.stdout.write(`\n[x] Failed: ${tableName}: ${e}\n`);
      failed++;
    }
  }

  // Clear the progress line and show final status
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(`\r[100%] ${total}/${total} files (${totalTime}s)` + ' '.repeat(30) + '\n');

  return { success, failed, skipped, cached };
}
