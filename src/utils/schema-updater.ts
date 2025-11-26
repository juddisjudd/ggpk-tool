// Schema Updater - Automatically fetches the latest dat-schema from GitHub
// Source: https://github.com/poe-tool-dev/dat-schema

import { existsSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';

const SCHEMA_URL = 'https://github.com/poe-tool-dev/dat-schema/releases/download/latest/schema.min.json';
const SCHEMA_PATH = './schema.min.json';
const SCHEMA_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

interface SchemaInfo {
  version: number;
  createdAt: number;
  tables: any[];
}

/**
 * Check if schema needs updating based on age
 */
async function shouldUpdateSchema(): Promise<{ needsUpdate: boolean; reason: string; localDate?: Date }> {
  if (!existsSync(SCHEMA_PATH)) {
    return { needsUpdate: true, reason: 'Schema file not found' };
  }

  try {
    const content = await readFile(SCHEMA_PATH, 'utf-8');
    const schema = JSON.parse(content) as SchemaInfo;
    
    if (!schema.createdAt) {
      return { needsUpdate: true, reason: 'Schema missing createdAt field' };
    }

    // createdAt is Unix timestamp in seconds
    const schemaDate = new Date(schema.createdAt * 1000);
    const ageMs = Date.now() - (schema.createdAt * 1000);
    
    if (ageMs > SCHEMA_CHECK_INTERVAL) {
      return { 
        needsUpdate: true, 
        reason: `Schema is ${Math.round(ageMs / (24 * 60 * 60 * 1000))} days old`,
        localDate: schemaDate
      };
    }

    return { 
      needsUpdate: false, 
      reason: 'Schema is up to date',
      localDate: schemaDate
    };
  } catch (e) {
    return { needsUpdate: true, reason: `Error reading schema: ${e}` };
  }
}

/**
 * Fetch the latest schema from GitHub
 */
async function fetchLatestSchema(): Promise<SchemaInfo> {
  console.log('[*] Fetching latest schema from GitHub...');
  
  const response = await fetch(SCHEMA_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch schema: ${response.status} ${response.statusText}`);
  }
  
  const schema = await response.json() as SchemaInfo;
  return schema;
}

/**
 * Get the PoE2-specific tables from the full schema
 * validFor is a bitmask: 1 = PoE1, 2 = PoE2, 3 = Both
 */
function filterPoe2Schema(schema: SchemaInfo): SchemaInfo {
  const POE2_BIT = 2;
  
  const poe2Tables = schema.tables.filter(table => {
    // If validFor includes PoE2 bit (2), include this table
    // validFor of 2 or 3 means it's valid for PoE2
    return (table.validFor & POE2_BIT) !== 0;
  });

  console.log(`   Found ${poe2Tables.length} PoE2 tables (${schema.tables.length} total)`);

  return {
    ...schema,
    tables: poe2Tables
  };
}

/**
 * Update schema if needed, returns the schema info
 */
export async function updateSchemaIfNeeded(forceUpdate = false): Promise<{ 
  updated: boolean; 
  schema: SchemaInfo;
  tableCount: number;
}> {
  const check = await shouldUpdateSchema();
  
  if (!forceUpdate && !check.needsUpdate) {
    console.log(`[+] Schema is current (${check.localDate?.toLocaleDateString()})`);
    const content = await readFile(SCHEMA_PATH, 'utf-8');
    const schema = JSON.parse(content) as SchemaInfo;
    return { updated: false, schema, tableCount: schema.tables.length };
  }

  console.log(`[!] ${check.reason}`);

  try {
    const remoteSchema = await fetchLatestSchema();
    // createdAt is Unix timestamp in seconds
    const remoteDate = new Date(remoteSchema.createdAt * 1000);
    
    // Check if remote is actually newer
    if (check.localDate && remoteDate <= check.localDate && !forceUpdate) {
      console.log(`[+] Local schema is already the latest version`);
      const content = await readFile(SCHEMA_PATH, 'utf-8');
      const schema = JSON.parse(content) as SchemaInfo;
      return { updated: false, schema, tableCount: schema.tables.length };
    }

    // Filter for PoE2 only
    const poe2Schema = filterPoe2Schema(remoteSchema);
    
    // Save the filtered schema
    await writeFile(SCHEMA_PATH, JSON.stringify(poe2Schema));
    console.log(`[+] Schema updated to ${remoteDate.toLocaleDateString()} (${poe2Schema.tables.length} PoE2 tables)`);
    
    return { updated: true, schema: poe2Schema, tableCount: poe2Schema.tables.length };
  } catch (e) {
    console.error('[x] Failed to update schema:', e);
    
    // Fall back to existing schema if available
    if (existsSync(SCHEMA_PATH)) {
      const content = await readFile(SCHEMA_PATH, 'utf-8');
      const schema = JSON.parse(content) as SchemaInfo;
      return { updated: false, schema, tableCount: schema.tables.length };
    }
    
    throw e;
  }
}

/**
 * Get current schema info without updating
 */
export async function getSchemaInfo(): Promise<{
  exists: boolean;
  createdAt?: Date;
  tableCount?: number;
  version?: number;
}> {
  if (!existsSync(SCHEMA_PATH)) {
    return { exists: false };
  }

  try {
    const content = await readFile(SCHEMA_PATH, 'utf-8');
    const schema = JSON.parse(content) as SchemaInfo;
    
    return {
      exists: true,
      // createdAt is Unix timestamp in seconds
      createdAt: schema.createdAt ? new Date(schema.createdAt * 1000) : undefined,
      tableCount: schema.tables?.length,
      version: schema.version
    };
  } catch {
    return { exists: false };
  }
}

// CLI support
if (import.meta.main) {
  const forceUpdate = process.argv.includes('--force') || process.argv.includes('-f');
  
  console.log('[*] Checking for schema updates...\n');
  
  try {
    const result = await updateSchemaIfNeeded(forceUpdate);
    console.log(`\n[i] Schema has ${result.tableCount} tables`);
  } catch (e) {
    console.error('\n[x] Schema update failed:', e);
    process.exit(1);
  }
}
