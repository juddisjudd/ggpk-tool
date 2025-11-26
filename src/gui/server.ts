// GGPK Explorer - GUI Server
// Single browser with smart preview for all file types
// AMOLED Dark Theme

import { serve } from 'bun';
import { loadConfig } from '../config';
import { 
  listBundledFiles, 
  getGGPKSummary,
  type ProgressInfo 
} from '../ggpk/bundle-extractor';
import { runExtractionPipeline, EXTRACTION_PRESETS, cleanupExtractedFiles } from '../extraction/extraction-pipeline';
import { DATParser } from '../dat/dat-parser';
import { updateSchemaIfNeeded, getSchemaInfo } from '../utils/schema-updater';
import { readdir, stat, readFile } from 'fs/promises';
import { join, extname, basename, sep, dirname, relative } from 'path';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';

const PORT = 3000;

// ============ FILE INDEX (Persistent Cache) ============
interface FileEntry {
  name: string;
  path: string;
  type: 'image' | 'audio' | 'json' | 'dat' | 'other';
  size: number;
  folder: string;
}

interface FileIndex {
  version: number;
  timestamp: number;
  files: FileEntry[];
  folderTree: FolderNode;
}

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  fileCount: number;
}

const INDEX_VERSION = 4;  // Bump: exclude .dds.header files
const INDEX_PATH = './temp/file-index.json';
let fileIndex: FileIndex | null = null;
let schema: any = null;

// File type detection
function getFileType(filename: string): FileEntry['type'] {
  const ext = extname(filename).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.dds'].includes(ext)) return 'image';
  if (['.ogg', '.wav', '.mp3'].includes(ext)) return 'audio';
  if (['.json'].includes(ext)) return 'json';
  if (['.datc64', '.dat'].includes(ext)) return 'dat';
  return 'other';
}

// Build folder tree from file list
function buildFolderTree(files: FileEntry[], rootPath: string): FolderNode {
  const root: FolderNode = { name: basename(rootPath), path: rootPath, children: [], fileCount: 0 };
  const folderMap = new Map<string, FolderNode>();
  folderMap.set('', root);

  for (const file of files) {
    const folder = file.folder;
    if (!folder) {
      root.fileCount++;
      continue;
    }

    const parts = folder.split('/');
    let currentPath = '';
    let currentNode = root;

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      
      if (!folderMap.has(currentPath)) {
        const newNode: FolderNode = { 
          name: part, 
          path: currentPath, 
          children: [], 
          fileCount: 0 
        };
        currentNode.children.push(newNode);
        folderMap.set(currentPath, newNode);
      }
      currentNode = folderMap.get(currentPath)!;
    }
    currentNode.fileCount++;
  }

  // Sort children alphabetically
  const sortChildren = (node: FolderNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sortChildren);
  };
  sortChildren(root);

  return root;
}

// Scan extracted directory and build index
async function buildFileIndex(extractedDir: string = './extracted'): Promise<FileIndex> {
  console.log('[*] Building file index...');
  const startTime = Date.now();
  
  const files: FileEntry[] = [];
  const rootPath = extractedDir.replace(/\\/g, '/');

  async function scan(dir: string) {
    if (!existsSync(dir)) return;
    
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name).replace(/\\/g, '/');
        
        if (entry.isDirectory()) {
          await scan(fullPath);
        } else {
          // Skip .dds.header files
          if (entry.name.endsWith('.dds.header')) continue;
          
          const relativePath = fullPath.replace(rootPath + '/', '');
          const folder = relativePath.includes('/') 
            ? relativePath.substring(0, relativePath.lastIndexOf('/')) 
            : '';
          
          let size = 0;
          try {
            const s = await stat(fullPath);
            size = s.size;
          } catch {}

          files.push({
            name: entry.name,
            path: fullPath,
            type: getFileType(entry.name),
            size,
            folder
          });
        }
      }
    } catch (e) {
      console.error('Scan error:', e);
    }
  }

  await scan(extractedDir);

  // Sort by folder, then name
  files.sort((a, b) => {
    if (a.folder !== b.folder) return a.folder.localeCompare(b.folder);
    return a.name.localeCompare(b.name);
  });

  const index: FileIndex = {
    version: INDEX_VERSION,
    timestamp: Date.now(),
    files,
    folderTree: buildFolderTree(files, extractedDir)
  };

  // Save to disk
  try {
    if (!existsSync('./temp')) {
      await Bun.write('./temp/.gitkeep', '');
    }
    await Bun.write(INDEX_PATH, JSON.stringify(index));
  } catch (e) {
    console.error('Failed to save index:', e);
  }

  console.log(`[+] Indexed ${files.length} files in ${Date.now() - startTime}ms`);
  return index;
}

// Load or build file index
async function getFileIndex(forceRebuild = false): Promise<FileIndex> {
  if (fileIndex && !forceRebuild) return fileIndex;

  // Try loading from disk
  if (!forceRebuild && existsSync(INDEX_PATH)) {
    try {
      const data = await Bun.file(INDEX_PATH).json();
      if (data.version === INDEX_VERSION) {
        console.log('[+] Loaded file index from cache');
        fileIndex = data;
        return fileIndex!;
      }
    } catch {}
  }

  fileIndex = await buildFileIndex();
  return fileIndex;
}

// Load schema for DAT parsing
async function getSchema() {
  if (!schema) {
    try {
      schema = await DATParser.loadSchema('./schema.min.json');
    } catch (e) {
      console.error('Failed to load schema:', e);
    }
  }
  return schema;
}

// Store active operations
const activeOperations = new Map<string, {
  type: string;
  status: 'running' | 'completed' | 'error';
  progress: ProgressInfo;
  error?: string;
}>();

// JSON helper
const json = (data: any, status = 200) => 
  new Response(JSON.stringify(data), { 
    status, 
    headers: { 'Content-Type': 'application/json' } 
  });

// Convert DDS to PNG buffer for preview
const ddsCache = new Map<string, Buffer>();

async function convertDDStoBuffer(ddsPath: string): Promise<Buffer | null> {
  if (ddsCache.has(ddsPath)) return ddsCache.get(ddsPath)!;
  
  const texconv = './external/texconv/texconv.exe';
  if (!existsSync(texconv) || !existsSync(ddsPath)) return null;

  const tempDir = './temp';
  if (!existsSync(tempDir)) await Bun.write(tempDir + '/.gitkeep', '');

  const result = spawnSync(texconv, ['-ft', 'png', '-o', tempDir, '-y', '-nologo', ddsPath], 
    { encoding: 'buffer', timeout: 5000 });

  if (result.error) return null;

  const pngPath = join(tempDir, basename(ddsPath).replace(/\.dds$/i, '.png'));
  if (existsSync(pngPath)) {
    try {
      const buffer = await readFile(pngPath);
      if (ddsCache.size < 100) ddsCache.set(ddsPath, buffer);
      try { await Bun.write(pngPath, ''); } catch {}
      return buffer;
    } catch {}
  }
  return null;
}

// API Handler
async function handleAPI(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.replace('/api/', '');

  try {
    const config = await loadConfig();
    const ggpkPath = config.poe2Path + '/Content.ggpk';

    // Status
    if (path === 'status') {
      const index = await getFileIndex();
      let ggpkInfo = null;
      try { ggpkInfo = await getGGPKSummary(ggpkPath); } catch {}
      
      // Get schema info
      const schemaInfo = await getSchemaInfo();
      
      return json({
        config: { poe2Path: config.poe2Path },
        ggpk: ggpkInfo,
        extracted: { fileCount: index.files.length },
        indexTimestamp: index.timestamp,
        schema: schemaInfo
      });
    }

    // Schema update
    if (path === 'update-schema') {
      try {
        const result = await updateSchemaIfNeeded(true); // Force update
        return json({ 
          success: true, 
          updated: result.updated, 
          tableCount: result.tableCount 
        });
      } catch (e) {
        return json({ success: false, error: String(e) }, 500);
      }
    }

    // Rebuild index
    if (path === 'rebuild-index') {
      fileIndex = await buildFileIndex();
      return json({ success: true, fileCount: fileIndex.files.length });
    }

    // Browse files with pagination
    if (path === 'browse') {
      const folder = url.searchParams.get('folder') || '';
      const page = parseInt(url.searchParams.get('page') || '1');
      const perPage = parseInt(url.searchParams.get('perPage') || '100');
      const type = url.searchParams.get('type') || ''; // Filter by type

      const index = await getFileIndex();
      
      // Filter files
      let filtered = index.files;
      if (folder) {
        filtered = filtered.filter(f => f.folder === folder || f.folder.startsWith(folder + '/'));
      }
      if (type) {
        filtered = filtered.filter(f => f.type === type);
      }

      // Get direct children only (files in this folder, not subfolders)
      const directFiles = folder 
        ? filtered.filter(f => f.folder === folder)
        : filtered.filter(f => !f.folder);

      // Get subfolders
      const subfolders = new Set<string>();
      for (const f of filtered) {
        if (folder) {
          if (f.folder.startsWith(folder + '/')) {
            const rest = f.folder.substring(folder.length + 1);
            const nextFolder = rest.split('/')[0];
            if (nextFolder) subfolders.add(folder + '/' + nextFolder);
          }
        } else {
          if (f.folder) {
            const topFolder = f.folder.split('/')[0];
            subfolders.add(topFolder);
          }
        }
      }

      const total = directFiles.length;
      const start = (page - 1) * perPage;
      const files = directFiles.slice(start, start + perPage);

      return json({
        folder,
        files,
        subfolders: Array.from(subfolders).sort(),
        total,
        page,
        perPage,
        hasMore: start + perPage < total
      });
    }

    // Search files
    if (path === 'search') {
      const query = url.searchParams.get('q') || '';
      const type = url.searchParams.get('type') || '';
      const limit = parseInt(url.searchParams.get('limit') || '50');

      if (!query || query.length < 2) {
        return json({ results: [], query });
      }

      const index = await getFileIndex();
      const queryLower = query.toLowerCase();
      
      let results = index.files.filter(f => 
        f.name.toLowerCase().includes(queryLower) ||
        f.folder.toLowerCase().includes(queryLower)
      );

      if (type) {
        results = results.filter(f => f.type === type);
      }

      return json({
        results: results.slice(0, limit),
        total: results.length,
        query
      });
    }

    // Get folder tree
    if (path === 'folders') {
      const index = await getFileIndex();
      return json({ tree: index.folderTree });
    }

    // File content/preview
    if (path === 'file') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return json({ error: 'Missing path' }, 400);

      const normalizedPath = filePath.replace(/\//g, sep);
      const ext = extname(normalizedPath).toLowerCase();
      const file = Bun.file(normalizedPath);
      
      if (!await file.exists()) {
        return json({ error: 'File not found' }, 404);
      }

      // JSON
      if (ext === '.json') {
        return new Response(file, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
        });
      }

      // Audio
      if (['.ogg', '.wav', '.mp3'].includes(ext)) {
        const mimeTypes: Record<string, string> = { '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
        return new Response(file, {
          headers: { 'Content-Type': mimeTypes[ext], 'Cache-Control': 'public, max-age=3600', 'Accept-Ranges': 'bytes' }
        });
      }

      // Images
      if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
        return new Response(file, {
          headers: { 'Content-Type': `image/${ext.slice(1)}`, 'Cache-Control': 'public, max-age=3600' }
        });
      }

      // DDS - convert to PNG
      if (ext === '.dds') {
        const pngBuffer = await convertDDStoBuffer(normalizedPath);
        if (pngBuffer) {
          return new Response(pngBuffer, {
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }
          });
        }
        // Fallback
        const fallback = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        return new Response(fallback, { headers: { 'Content-Type': 'image/png' } });
      }

      // DAT files - parse and return JSON
      if (ext === '.datc64' || ext === '.dat') {
        try {
          const sch = await getSchema();
          if (sch) {
            const parser = new DATParser(sch, true);
            const tableName = basename(normalizedPath).replace(/\.datc?64$/i, '').toLowerCase();
            const buffer = Buffer.from(await file.arrayBuffer());
            const parsed = parser.parse(buffer, tableName);
            
            return json({
              tableName,
              rowCount: parsed?.rows?.length || 0,
              rows: parsed?.rows || [],
              raw: false
            });
          }
        } catch (e) {
          console.error('DAT parse error:', e);
        }
        
        // Fallback: return hex preview
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer.slice(0, 2048));
        return json({
          tableName: basename(normalizedPath),
          raw: true,
          hex: Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' '),
          size: buffer.byteLength
        });
      }

      // Default: text
      return new Response(await file.text(), {
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Export DAT to JSON file
    if (path === 'export-json' && req.method === 'POST') {
      const { datPath } = await req.json() as { datPath: string };
      const normalizedPath = datPath.replace(/\//g, sep);
      
      const sch = await getSchema();
      if (!sch) return json({ error: 'Schema not loaded' }, 500);
      
      const parser = new DATParser(sch, true);
      const tableName = basename(normalizedPath).replace(/\.datc?64$/i, '').toLowerCase();
      const file = Bun.file(normalizedPath);
      const buffer = Buffer.from(await file.arrayBuffer());
      const parsed = parser.parse(buffer, tableName);
      
      const jsonPath = normalizedPath.replace(/\.datc?64$/i, '.json');
      await Bun.write(jsonPath, JSON.stringify(parsed, null, 2));
      
      // Rebuild index to include new file
      fileIndex = await buildFileIndex();
      
      return json({ success: true, jsonPath });
    }

    // Extract endpoint
    if (path === 'extract' && req.method === 'POST') {
      const body = await req.json() as any;
      const { preset, pattern, convertImages, parseDat } = body;

      const opId = Date.now().toString();
      activeOperations.set(opId, {
        type: 'extract',
        status: 'running',
        progress: { phase: 'indexing', current: 0, total: 0 }
      });

      (async () => {
        try {
          const extractPattern = preset ? EXTRACTION_PRESETS[preset as keyof typeof EXTRACTION_PRESETS]?.pattern : pattern;
          
          const result = await runExtractionPipeline(extractPattern || '.*', {
            ggpkPath,
            outputDir: './extracted',
            schemaPath: './schema.min.json',
            convertImages: convertImages !== false,
            parseDatFiles: parseDat !== false,
            excludeLanguages: true,
            onProgress: (info) => {
              activeOperations.set(opId, { type: 'extract', status: 'running', progress: info });
            }
          });

          // Rebuild index after extraction
          fileIndex = await buildFileIndex();

          activeOperations.set(opId, {
            type: 'extract',
            status: 'completed',
            progress: { phase: 'done', current: result.extracted, total: result.extracted }
          });
        } catch (e) {
          activeOperations.set(opId, {
            type: 'extract',
            status: 'error',
            progress: { phase: 'done', current: 0, total: 1 },
            error: String(e)
          });
        }
      })();

      return json({ operationId: opId });
    }

    // Cleanup endpoint
    if (path === 'cleanup' && req.method === 'POST') {
      const result = await cleanupExtractedFiles('./extracted');
      fileIndex = await buildFileIndex();
      return json({ success: true, removed: result });
    }

    // Operation status
    if (path.startsWith('operation/')) {
      const opId = path.replace('operation/', '');
      const op = activeOperations.get(opId);
      if (!op) return json({ error: 'Operation not found' }, 404);
      return json(op);
    }

    return json({ error: 'Unknown endpoint' }, 404);
  } catch (e) {
    console.error('API error:', e);
    return json({ error: String(e) }, 500);
  }
}

// HTML Template
function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GGPK Explorer</title>
  <style>
    :root {
      --bg-primary: #000;
      --bg-secondary: #0a0a0a;
      --bg-tertiary: #111;
      --border: #1a1a1a;
      --text: #e0e0e0;
      --text-muted: #666;
      --accent: #3b82f6;
      --accent-hover: #60a5fa;
      --success: #22c55e;
      --error: #ef4444;
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text);
      height: 100vh;
      overflow: hidden;
    }
    
    /* Layout */
    .app { display: flex; flex-direction: column; height: 100vh; }
    
    header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 16px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      height: 52px;
    }
    
    header h1 { font-size: 15px; font-weight: 600; white-space: nowrap; }
    
    .spacer { flex: 1; }
    
    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .search-box {
      width: 260px;
      position: relative;
    }
    
    .search-box input {
      width: 100%;
      padding: 7px 12px 7px 32px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 13px;
    }
    
    .search-box input:focus { outline: none; border-color: var(--accent); }
    
    .search-box::before {
      content: '';
      position: absolute;
      left: 10px;
      top: 50%;
      transform: translateY(-50%);
      width: 14px;
      height: 14px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23888' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.35-4.35'/%3E%3C/svg%3E");
      background-size: contain;
    }
    
    .search-results {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-top: 6px;
      max-height: 400px;
      overflow: auto;
      z-index: 100;
      display: none;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }
    
    .search-results.active { display: block; }
    
    .search-result {
      padding: 10px 14px;
      cursor: pointer;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .search-result:last-child { border-bottom: none; }
    .search-result:hover { background: var(--bg-tertiary); }
    .search-result .type { font-size: 16px; flex-shrink: 0; }
    .search-result .type svg { width: 18px; height: 18px; }
    .search-result .info { flex: 1; min-width: 0; }
    .search-result .name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .search-result .path { font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    
    main { display: flex; flex: 1; overflow: hidden; }
    
    /* Sidebar */
    .sidebar {
      width: 250px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    .sidebar-header {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .folder-tree {
      flex: 1;
      overflow: auto;
      padding: 8px;
    }
    
    .folder-item {
      padding: 8px 10px;
      cursor: pointer;
      border-radius: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      margin-bottom: 2px;
    }
    
    .folder-item:hover { background: var(--bg-tertiary); }
    .folder-item.selected { background: var(--accent); color: white; }
    .folder-item .icon { display: flex; align-items: center; }
    .folder-item .count { color: var(--text-muted); font-size: 11px; margin-left: auto; }
    
    /* File List */
    .file-list-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    .file-list-header {
      padding: 10px 16px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 13px;
      min-height: 42px;
    }
    
    .breadcrumb { display: flex; align-items: center; gap: 4px; flex: 1; overflow: hidden; }
    .breadcrumb span { cursor: pointer; color: var(--text-muted); display: flex; align-items: center; gap: 4px; white-space: nowrap; }
    .breadcrumb span:hover { color: var(--text); }
    .breadcrumb span.current { color: var(--text); }
    .breadcrumb-icon { width: 14px; height: 14px; flex-shrink: 0; }
    
    /* Grid view (default for images/folders) */
    .file-list {
      flex: 1;
      overflow: auto;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      gap: 8px;
      padding: 12px;
      align-content: start;
    }
    
    /* List view for data files */
    .file-list.list-view {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 8px 12px;
    }
    
    .file-list.list-view .file-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      text-align: left;
      border-radius: 4px;
      flex-direction: row;
      justify-content: flex-start;
    }
    
    .file-list.list-view .file-item .icon {
      margin-bottom: 0;
      flex-shrink: 0;
    }
    
    .file-list.list-view .file-item .icon svg { width: 18px; height: 18px; }
    .file-list.list-view .file-item .name { font-size: 13px; flex: 1; word-break: break-word; }
    .file-list.list-view .file-item:hover { transform: none; background: var(--bg-tertiary); }
    
    .file-item {
      padding: 12px 8px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    
    .file-item:hover { border-color: var(--accent); transform: translateY(-2px); }
    .file-item.selected { border-color: var(--accent); background: var(--bg-tertiary); }
    .file-item .icon { margin-bottom: 8px; display: flex; align-items: center; justify-content: center; }
    .file-item .icon svg { width: 32px; height: 32px; color: var(--text-muted); }
    .file-item .name { font-size: 11px; word-break: break-all; color: var(--text-muted); line-height: 1.3; }
    .file-item.folder .icon svg { width: 36px; height: 36px; }
    
    /* Colored icons for specific file types */
    .file-item .icon.icon-image svg { color: #2ecc71; }
    .file-item .icon.icon-audio svg { color: #686de0; }
    .file-item .icon.icon-json svg { color: #f39c12; }
    .file-item .icon.icon-dat svg { color: #9b59b6; }
    
    .folder-item .icon svg { width: 14px; height: 14px; }
    
    .audio-icon { margin-bottom: 16px; }
    .audio-icon svg { width: 64px; height: 64px; color: var(--text-muted); }
    
    .file-item img {
      width: 80px;
      height: 80px;
      object-fit: contain;
      border-radius: 4px;
      margin-bottom: 8px;
    }
    
    /* Preview Panel */
    .preview-panel {
      width: 550px;
      min-width: 350px;
      max-width: 800px;
      background: var(--bg-secondary);
      border-left: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }
    
    .resize-handle {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 5px;
      cursor: ew-resize;
      background: transparent;
      z-index: 10;
    }
    
    .resize-handle:hover,
    .resize-handle.active {
      background: var(--accent);
    }
    
    .preview-header {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 42px;
      overflow: hidden;
    }
    
    .preview-header .file-type {
      padding: 3px 8px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 600;
      flex-shrink: 0;
    }
    
    .preview-content {
      flex: 1;
      overflow: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
    }
    
    .preview-content.empty { 
      color: var(--text-muted); 
      justify-content: center;
    }
    
    /* Image preview */
    .image-preview {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
    }
    
    .image-preview img {
      max-width: 100%;
      max-height: 400px;
      object-fit: contain;
      border-radius: 4px;
      background: repeating-conic-gradient(#222 0% 25%, #1a1a1a 0% 50%) 50%/16px 16px;
    }
    
    .image-preview .image-info {
      margin-top: 12px;
      padding: 8px 12px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      font-size: 12px;
      color: var(--text-muted);
    }
    
    /* Audio preview */
    .audio-preview {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
      padding: 20px;
    }
    
    .audio-preview .audio-icon { margin-bottom: 20px; }
    .audio-preview .audio-icon svg { width: 80px; height: 80px; color: #686de0; }
    .audio-preview audio { width: 100%; max-width: 400px; }
    .audio-preview .audio-info {
      margin-top: 16px;
      font-size: 14px;
      color: var(--text);
    }
    
    /* JSON preview with syntax highlighting */
    .json-preview {
      width: 100%;
      height: 100%;
    }
    
    .json-preview pre {
      width: 100%;
      padding: 16px;
      background: var(--bg-tertiary);
      border-radius: 6px;
      font-size: 12px;
      font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
      overflow: auto;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    
    /* JSON syntax highlighting */
    .json-key { color: #9cdcfe; }
    .json-string { color: #ce9178; }
    .json-number { color: #b5cea8; }
    .json-boolean { color: #569cd6; }
    .json-null { color: #569cd6; }
    .json-bracket { color: #808080; }
    
    .preview-content pre {
      width: 100%;
      padding: 12px;
      background: var(--bg-tertiary);
      border-radius: 6px;
      font-size: 12px;
      overflow: auto;
    }
    
    .preview-actions {
      padding: 12px;
      border-top: 1px solid var(--border);
      display: flex;
      gap: 8px;
    }
    
    /* Data Table */
    .data-table {
      width: 100%;
      font-size: 12px;
      border-collapse: collapse;
    }
    
    .data-table th, .data-table td {
      padding: 6px 8px;
      border: 1px solid var(--border);
      text-align: left;
    }
    
    .data-table th {
      background: var(--bg-tertiary);
      position: sticky;
      top: 0;
    }
    
    .data-table tr:hover { background: var(--bg-tertiary); }
    
    /* Buttons */
    .btn {
      padding: 7px 14px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.15s;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    
    .btn-primary {
      background: var(--accent);
      color: white;
    }
    
    .btn-primary:hover { background: var(--accent-hover); }
    
    .btn-ghost {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border);
    }
    
    .btn-ghost:hover { background: var(--bg-tertiary); border-color: var(--text-muted); }
    
    .btn-sm { padding: 5px 10px; font-size: 12px; }
    
    .btn .icon, button .icon {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
    }
    
    .btn-sm .icon {
      width: 13px;
      height: 13px;
    }
    
    /* GGPK Status */
    .ggpk-status {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      font-size: 12px;
      color: var(--text-muted);
      border: 1px solid var(--border);
    }
    
    .ggpk-status .status-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #666;
    }
    
    .ggpk-status.mounting .status-indicator {
      width: 12px;
      height: 12px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      background: transparent;
      animation: spin 1s linear infinite;
    }
    
    .ggpk-status.mounted .status-indicator {
      background: #22c55e;
      box-shadow: 0 0 6px #22c55e;
    }
    
    .ggpk-status.error .status-indicator {
      background: #ef4444;
    }
    
    .ggpk-status.mounted .status-text {
      color: var(--text);
    }
    
    /* Status Bar */
    .status-bar {
      padding: 8px 16px;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 36px;
    }
    
    .schema-info {
      color: var(--text-muted);
      opacity: 0.8;
    }
    
    .schema-info .schema-label {
      color: var(--text-secondary);
    }
    
    /* Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    
    .modal {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      width: 480px;
      max-width: 90%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    }
    
    .modal-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .modal-header h2 { font-size: 16px; margin: 0; font-weight: 600; }
    .modal-close { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 24px; line-height: 1; padding: 0; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 4px; }
    .modal-close:hover { background: var(--bg-tertiary); color: var(--text); }
    
    .modal-body { padding: 20px; }
    
    .modal-footer {
      padding: 16px 20px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 500; color: var(--text); }
    
    .form-group select, .form-group input[type="text"] {
      width: 100%;
      padding: 10px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 14px;
    }
    
    .form-group select:focus, .form-group input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }
    
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
      padding: 8px 0;
    }
    
    .checkbox-group input[type="checkbox"] { 
      width: 16px; 
      height: 16px; 
      accent-color: var(--accent);
    }
    
    .checkbox-group label {
      font-size: 13px;
      color: var(--text);
      cursor: pointer;
    }
    
    .progress-bar {
      height: 6px;
      background: var(--bg-tertiary);
      border-radius: 3px;
      overflow: hidden;
      margin-top: 16px;
    }
    
    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--accent), var(--accent-hover));
      transition: width 0.3s ease;
    }
    
    /* Toast */
    .toast {
      position: fixed;
      bottom: 60px;
      right: 20px;
      padding: 14px 20px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 13px;
      z-index: 1000;
      animation: slideIn 0.3s ease;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    }
    
    .toast.success { border-color: var(--success); }
    .toast.error { border-color: var(--error); }
    
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    /* Loading */
    .loading {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-muted);
    }
    
    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <h1>GGPK Explorer</h1>
      <div id="ggpkStatus" class="ggpk-status mounting">
        <span class="status-indicator"></span>
        <span class="status-text">Mounting...</span>
      </div>
      <div class="spacer"></div>
      <div class="header-actions">
        <button class="btn btn-ghost btn-sm" onclick="showExtractDialog()"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/></svg>Extract</button>
        <button class="btn btn-ghost btn-sm" onclick="rebuildIndex()"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>Refresh</button>
        <div class="search-box">
          <input type="text" id="searchInput" placeholder="Search files..." oninput="handleSearch(this.value)">
          <div id="searchResults" class="search-results"></div>
        </div>
      </div>
    </header>
    
    <main>
      <div class="sidebar">
        <div class="sidebar-header">
          <button class="btn btn-ghost btn-sm" onclick="navigateUp()" title="Go up"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg></button>
          <button class="btn btn-ghost btn-sm" onclick="navigateHome()" title="Home"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg></button>
        </div>
        <div id="folderTree" class="folder-tree"></div>
      </div>
      
      <div class="file-list-container">
        <div class="file-list-header">
          <div id="breadcrumb" class="breadcrumb"></div>
          <span id="fileCount" class="count"></span>
        </div>
        <div id="fileList" class="file-list"></div>
      </div>
      
      <div class="preview-panel" id="previewPanel">
        <div class="resize-handle" id="resizeHandle"></div>
        <div class="preview-header" id="previewHeader">Preview</div>
        <div id="previewContent" class="preview-content empty">Select a file</div>
        <div id="previewActions" class="preview-actions" style="display: none;"></div>
      </div>
    </main>
    
    <div class="status-bar">
      <span id="statusText">Ready</span>
      <span id="schemaInfo" class="schema-info"></span>
      <span id="fileStats"></span>
    </div>
  </div>
  
  <!-- Extract Modal -->
  <div id="extractModal" class="modal-overlay" style="display: none;">
    <div class="modal">
      <div class="modal-header">
        <h2>Extract from GGPK</h2>
        <button class="modal-close" onclick="closeExtractModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Extraction Preset</label>
          <select id="extractPreset">
            <option value="data">Data Tables (.datc64 → .json)</option>
            <option value="textures">Textures (.dds → .webp)</option>
            <option value="audio">Audio Files (.ogg, .wav)</option>
            <option value="ui">UI Artwork</option>
            <option value="items">Item Icons</option>
            <option value="skills">Skill Icons</option>
            <option value="passives">Passive Icons</option>
            <option value="all">All Files (Large!)</option>
            <option value="custom">Custom Pattern</option>
          </select>
        </div>
        <div class="form-group" id="customPatternGroup" style="display: none;">
          <label>Custom Regex Pattern</label>
          <input type="text" id="customPattern" placeholder="e.g., .*\\\\.dds$">
        </div>
        <div class="checkbox-group">
          <input type="checkbox" id="convertImages" checked>
          <label for="convertImages">Convert DDS to WebP</label>
        </div>
        <div class="checkbox-group">
          <input type="checkbox" id="parseDat" checked>
          <label for="parseDat">Parse DAT to JSON</label>
        </div>
        <div id="extractProgress" style="display: none;">
          <div style="font-size: 13px; color: var(--text-muted);" id="extractProgressText">Preparing...</div>
          <div class="progress-bar">
            <div class="progress-bar-fill" id="extractProgressBar" style="width: 0%;"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeExtractModal()">Cancel</button>
        <button class="btn btn-primary" id="extractBtn" onclick="startExtraction()">Extract</button>
      </div>
    </div>
  </div>
  
  <script>
    let currentFolder = '';
    let selectedFile = null;
    let searchTimeout = null;
    let extracting = false;
    
    const icons = {
      image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
      audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
      json: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>',
      dat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3zM3 9h18M9 21V9"/></svg>',
      other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M13 2v7h7"/></svg>',
      folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
      up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>'
    };
    
    // Initialize
    async function init() {
      await loadFolder('');
      updateStatus();
      
      // Setup preset change handler
      document.getElementById('extractPreset').onchange = function() {
        document.getElementById('customPatternGroup').style.display = 
          this.value === 'custom' ? 'block' : 'none';
      };
    }
    
    // Load folder contents
    async function loadFolder(folder) {
      currentFolder = folder;
      selectedFile = null;
      
      document.getElementById('fileList').innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';
      
      try {
        const res = await fetch(\`/api/browse?folder=\${encodeURIComponent(folder)}&perPage=2000\`);
        const data = await res.json();
        
        renderBreadcrumb(folder);
        renderFolderTree(data.subfolders);
        renderFileList(data.files, data.subfolders);
        
        document.getElementById('fileCount').textContent = \`\${data.total} files\`;
      } catch (e) {
        toast('Failed to load folder: ' + e, 'error');
      }
    }
    
    // Render breadcrumb navigation
    function renderBreadcrumb(folder) {
      const el = document.getElementById('breadcrumb');
      let html = '<span onclick="loadFolder(\\'\\')"><svg class="breadcrumb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>extracted</span>';
      
      if (folder) {
        const parts = folder.split('/');
        let path = '';
        for (let i = 0; i < parts.length; i++) {
          path = path ? path + '/' + parts[i] : parts[i];
          const isLast = i === parts.length - 1;
          html += \` / <span class="\${isLast ? 'current' : ''}" onclick="loadFolder('\${path}')">\${parts[i]}</span>\`;
        }
      }
      
      el.innerHTML = html;
    }
    
    // Render folder tree in sidebar
    function renderFolderTree(subfolders) {
      const el = document.getElementById('folderTree');
      
      // Add parent folder option
      let html = '';
      if (currentFolder) {
        const parent = currentFolder.includes('/') ? currentFolder.substring(0, currentFolder.lastIndexOf('/')) : '';
        html += \`<div class="folder-item" onclick="loadFolder('\${parent}')"><span class="icon">\${icons.up}</span>..</div>\`;
      }
      
      // Add subfolders
      for (const folder of subfolders) {
        const name = folder.split('/').pop();
        html += \`<div class="folder-item" onclick="loadFolder('\${folder}')"><span class="icon">\${icons.folder}</span>\${name}</div>\`;
      }
      
      el.innerHTML = html || '<div style="color: var(--text-muted); padding: 12px; font-size: 12px;">No subfolders</div>';
    }
    
    // Render file list
    function renderFileList(files, subfolders) {
      const el = document.getElementById('fileList');
      let html = '';
      
      // Check if this is a data folder (mostly JSON/DAT files)
      const isDataFolder = currentFolder.includes('data') || 
        files.filter(f => f.type === 'json' || f.type === 'dat').length > files.length * 0.5;
      
      // Use list view for data folders
      if (isDataFolder && files.length > 0) {
        el.classList.add('list-view');
      } else {
        el.classList.remove('list-view');
      }
      
      // Folders first
      for (const folder of subfolders) {
        const name = folder.split('/').pop();
        html += \`
          <div class="file-item folder" ondblclick="loadFolder('\${folder}')">
            <div class="icon icon-folder">\${icons.folder}</div>
            <div class="name">\${name}</div>
          </div>
        \`;
      }
      
      // Then files
      for (const file of files) {
        const icon = icons[file.type] || icons.other;
        const iconClass = 'icon-' + (file.type || 'other');
        const isImage = file.type === 'image' && !isDataFolder;
        const escapedPath = file.path.replace(/'/g, "\\\\'");
        
        html += \`
          <div class="file-item" onclick="selectFile('\${escapedPath}', '\${file.type}')" data-path="\${file.path}">
            \${isImage 
              ? \`<img src="/api/file?path=\${encodeURIComponent(file.path)}" loading="lazy" onerror="this.style.display='none'">\`
              : \`<div class="icon \${iconClass}">\${icon}</div>\`
            }
            <div class="name">\${file.name}</div>
          </div>
        \`;
      }
      
      el.innerHTML = html || '<div style="grid-column: 1/-1; color: var(--text-muted); padding: 20px; text-align: center;">No files in this folder</div>';
    }
    
    // Select file for preview
    async function selectFile(path, type) {
      // Update selection UI
      document.querySelectorAll('.file-item.selected').forEach(e => e.classList.remove('selected'));
      const item = document.querySelector(\`.file-item[data-path="\${path}"]\`);
      if (item) item.classList.add('selected');
      
      selectedFile = { path, type };
      
      const header = document.getElementById('previewHeader');
      const content = document.getElementById('previewContent');
      const actions = document.getElementById('previewActions');
      
      const filename = path.split('/').pop();
      const ext = filename.split('.').pop().toUpperCase();
      header.innerHTML = \`\${filename}<span class="file-type">\${ext}</span>\`;
      content.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';
      content.classList.remove('empty');
      actions.style.display = 'none';
      
      try {
        if (type === 'image') {
          const img = new Image();
          img.onload = function() {
            content.innerHTML = \`
              <div class="image-preview">
                <img src="/api/file?path=\${encodeURIComponent(path)}" alt="\${filename}">
                <div class="image-info">\${this.naturalWidth} × \${this.naturalHeight} px</div>
              </div>
            \`;
          };
          img.onerror = function() {
            content.innerHTML = '<div style="color: var(--error);">Failed to load image</div>';
          };
          img.src = \`/api/file?path=\${encodeURIComponent(path)}\`;
        } 
        else if (type === 'audio') {
          content.innerHTML = \`
            <div class="audio-preview">
              <div class="audio-icon">\${icons.audio}</div>
              <audio controls src="/api/file?path=\${encodeURIComponent(path)}"></audio>
              <div class="audio-info">\${filename}</div>
            </div>
          \`;
        }
        else if (type === 'json') {
          const res = await fetch(\`/api/file?path=\${encodeURIComponent(path)}\`);
          const data = await res.json();
          const highlighted = syntaxHighlight(JSON.stringify(data, null, 2).slice(0, 50000));
          content.innerHTML = \`<div class="json-preview"><pre>\${highlighted}</pre></div>\`;
        }
        else if (type === 'dat') {
          const res = await fetch(\`/api/file?path=\${encodeURIComponent(path)}\`);
          const data = await res.json();
          
          if (data.raw) {
            content.innerHTML = \`
              <div style="margin-bottom: 12px;">
                <strong>\${data.tableName}</strong> (raw, \${formatSize(data.size)})
              </div>
              <pre style="font-size: 10px;">\${data.hex}</pre>
            \`;
          } else {
            let html = \`<div style="margin-bottom: 12px;"><strong>\${data.tableName}</strong> - \${data.rowCount} rows</div>\`;
            
            if (data.rows && data.rows.length > 0) {
              html += '<div style="overflow: auto; max-height: 350px;"><table class="data-table"><thead><tr>';
              
              const cols = data.columns || Object.keys(data.rows[0]);
              for (const col of cols.slice(0, 10)) {
                html += \`<th>\${col.name || col}</th>\`;
              }
              html += '</tr></thead><tbody>';
              
              for (const row of data.rows.slice(0, 50)) {
                html += '<tr>';
                for (const col of cols.slice(0, 10)) {
                  const key = col.name || col;
                  const val = row[key];
                  html += \`<td>\${formatValue(val)}</td>\`;
                }
                html += '</tr>';
              }
              
              html += '</tbody></table></div>';
              if (data.rows.length > 50) {
                html += \`<div style="margin-top: 8px; color: var(--text-muted); font-size: 11px;">Showing 50 of \${data.rows.length} rows</div>\`;
              }
            }
            
            content.innerHTML = html;
            
            // Show export action
            actions.innerHTML = '<button class="btn btn-primary btn-sm" onclick="exportToJson()"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>Export to JSON</button>';
            actions.style.display = 'flex';
          }
        }
        else {
          const res = await fetch(\`/api/file?path=\${encodeURIComponent(path)}\`);
          const text = await res.text();
          content.innerHTML = \`<pre>\${text.slice(0, 5000)}</pre>\`;
        }
      } catch (e) {
        content.innerHTML = \`<div style="color: var(--error);">Failed to load: \${e}</div>\`;
      }
    }
    
    function formatValue(val) {
      if (val === null || val === undefined) return '<span style="color: var(--text-muted)">null</span>';
      if (typeof val === 'object') return JSON.stringify(val).slice(0, 50);
      return String(val).slice(0, 100);
    }
    
    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
    
    // JSON syntax highlighting
    function syntaxHighlight(json) {
      return json
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function(match) {
          let cls = 'json-number';
          if (/^"/.test(match)) {
            if (/:$/.test(match)) {
              cls = 'json-key';
            } else {
              cls = 'json-string';
            }
          } else if (/true|false/.test(match)) {
            cls = 'json-boolean';
          } else if (/null/.test(match)) {
            cls = 'json-null';
          }
          return '<span class="' + cls + '">' + match + '</span>';
        })
        .replace(/[\[\]{}]/g, function(match) {
          return '<span class="json-bracket">' + match + '</span>';
        });
    }
    
    // Export DAT to JSON
    async function exportToJson() {
      if (!selectedFile || selectedFile.type !== 'dat') return;
      
      try {
        const res = await fetch('/api/export-json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ datPath: selectedFile.path })
        });
        
        const data = await res.json();
        if (data.success) {
          toast('Exported to JSON', 'success');
          loadFolder(currentFolder);
        } else {
          toast('Export failed', 'error');
        }
      } catch (e) {
        toast('Export failed: ' + e, 'error');
      }
    }
    
    // Search
    function handleSearch(query) {
      clearTimeout(searchTimeout);
      const results = document.getElementById('searchResults');
      
      if (!query || query.length < 2) {
        results.classList.remove('active');
        return;
      }
      
      searchTimeout = setTimeout(async () => {
        try {
          const res = await fetch(\`/api/search?q=\${encodeURIComponent(query)}&limit=20\`);
          const data = await res.json();
          
          if (data.results.length === 0) {
            results.innerHTML = '<div style="padding: 16px; color: var(--text-muted); text-align: center;">No results found</div>';
          } else {
            results.innerHTML = data.results.map(f => \`
              <div class="search-result" onclick="goToFile('\${f.path.replace(/'/g, "\\\\'")}', '\${f.type}')">
                <span class="type">\${icons[f.type] || icons.other}</span>
                <div class="info">
                  <div class="name">\${f.name}</div>
                  <div class="path">\${f.folder || '/'}</div>
                </div>
              </div>
            \`).join('');
          }
          
          results.classList.add('active');
        } catch (e) {
          console.error('Search error:', e);
        }
      }, 300);
    }
    
    function goToFile(path, type) {
      document.getElementById('searchResults').classList.remove('active');
      document.getElementById('searchInput').value = '';
      
      const folder = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
      const filename = path.split('/').pop();
      
      loadFolder(folder).then(() => {
        setTimeout(() => selectFile(path, type), 100);
      });
    }
    
    // Navigation
    function navigateUp() {
      if (currentFolder) {
        const parent = currentFolder.includes('/') ? currentFolder.substring(0, currentFolder.lastIndexOf('/')) : '';
        loadFolder(parent);
      }
    }
    
    function navigateHome() {
      loadFolder('');
    }
    
    // Rebuild index
    async function rebuildIndex() {
      toast('Rebuilding index...', '');
      try {
        await fetch('/api/rebuild-index');
        await loadFolder(currentFolder);
        toast('Index rebuilt', 'success');
      } catch (e) {
        toast('Failed: ' + e, 'error');
      }
    }
    
    // Extract Modal
    function showExtractDialog() {
      document.getElementById('extractModal').style.display = 'flex';
      document.getElementById('extractProgress').style.display = 'none';
      document.getElementById('extractBtn').disabled = false;
    }
    
    function closeExtractModal() {
      if (!extracting) {
        document.getElementById('extractModal').style.display = 'none';
      }
    }
    
    async function startExtraction() {
      const preset = document.getElementById('extractPreset').value;
      const customPattern = document.getElementById('customPattern').value;
      const convertImages = document.getElementById('convertImages').checked;
      const parseDat = document.getElementById('parseDat').checked;
      
      extracting = true;
      document.getElementById('extractBtn').disabled = true;
      document.getElementById('extractProgress').style.display = 'block';
      document.getElementById('extractProgressText').textContent = 'Starting extraction...';
      document.getElementById('extractProgressBar').style.width = '0%';
      
      try {
        const body = {
          preset: preset !== 'custom' ? preset : undefined,
          pattern: preset === 'custom' ? customPattern : undefined,
          convertImages,
          parseDat
        };
        
        const res = await fetch('/api/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        
        const { operationId } = await res.json();
        pollExtraction(operationId);
      } catch (e) {
        extracting = false;
        document.getElementById('extractBtn').disabled = false;
        toast('Failed: ' + e, 'error');
      }
    }
    
    async function pollExtraction(opId) {
      const check = async () => {
        try {
          const res = await fetch(\`/api/operation/\${opId}\`);
          const op = await res.json();
          
          const progress = op.progress;
          const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
          
          document.getElementById('extractProgressText').textContent = 
            \`\${progress.phase}: \${progress.current}/\${progress.total} \${progress.currentFile || ''}\`.slice(0, 80);
          document.getElementById('extractProgressBar').style.width = pct + '%';
          document.getElementById('statusText').textContent = 
            \`Extracting: \${progress.phase} (\${pct}%)\`;
          
          if (op.status === 'completed') {
            extracting = false;
            document.getElementById('extractModal').style.display = 'none';
            toast(\`Extraction completed! \${progress.current} files extracted.\`, 'success');
            await loadFolder(currentFolder);
            updateStatus();
          } else if (op.status === 'error') {
            extracting = false;
            document.getElementById('extractBtn').disabled = false;
            document.getElementById('extractProgressText').textContent = 'Error: ' + op.error;
            toast('Extraction failed: ' + op.error, 'error');
          } else {
            setTimeout(check, 300);
          }
        } catch (e) {
          extracting = false;
          document.getElementById('extractBtn').disabled = false;
          toast('Error polling: ' + e, 'error');
        }
      };
      check();
    }
    
    async function updateStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        document.getElementById('fileStats').textContent = \`\${data.extracted.fileCount.toLocaleString()} files indexed\`;
        
        // Update schema info
        const schemaEl = document.getElementById('schemaInfo');
        if (data.schema && data.schema.exists) {
          const schemaDate = data.schema.createdAt ? new Date(data.schema.createdAt).toLocaleDateString() : 'Unknown';
          schemaEl.innerHTML = \`<span class="schema-label">Schema:</span> \${schemaDate} (\${data.schema.tableCount} tables)\`;
        } else {
          schemaEl.innerHTML = '<span class="schema-label">Schema:</span> Not loaded';
        }
        
        const statusEl = document.getElementById('ggpkStatus');
        statusEl.classList.remove('mounting', 'mounted', 'error');
        
        if (data.ggpk) {
          statusEl.classList.add('mounted');
          statusEl.querySelector('.status-text').textContent = 
            \`Content.ggpk (\${formatNumber(data.ggpk.bundleCount)} bundles, \${formatNumber(data.ggpk.fileCount)} files)\`;
        } else {
          statusEl.classList.add('error');
          statusEl.querySelector('.status-text').textContent = 'Not mounted';
        }
      } catch (e) {
        const statusEl = document.getElementById('ggpkStatus');
        statusEl.classList.remove('mounting', 'mounted');
        statusEl.classList.add('error');
        statusEl.querySelector('.status-text').textContent = 'Connection error';
      }
    }
    
    function formatNumber(n) {
      return n?.toLocaleString() || '0';
    }
    
    // Toast notification
    function toast(message, type = '') {
      const existing = document.querySelector('.toast');
      if (existing) existing.remove();
      
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.textContent = message;
      document.body.appendChild(el);
      
      setTimeout(() => el.remove(), 3000);
    }
    
    // Close search on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-box')) {
        document.getElementById('searchResults').classList.remove('active');
      }
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('searchResults').classList.remove('active');
        closeExtractModal();
      }
      if (e.key === 'Backspace' && !e.target.matches('input')) {
        navigateUp();
      }
    });
    
    // Preview panel resize
    (function() {
      const resizeHandle = document.getElementById('resizeHandle');
      const previewPanel = document.getElementById('previewPanel');
      let isResizing = false;
      
      resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        resizeHandle.classList.add('active');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });
      
      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const containerRight = window.innerWidth;
        const newWidth = containerRight - e.clientX;
        const clampedWidth = Math.max(350, Math.min(800, newWidth));
        previewPanel.style.width = clampedWidth + 'px';
      });
      
      document.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          resizeHandle.classList.remove('active');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });
    })();
    
    // Initialize
    init();
  </script>
</body>
</html>`;
}

// Start server
export async function startGUI(): Promise<void> {
  // Pre-load index
  console.log('Loading file index...');
  await getFileIndex();
  
  // Pre-load schema
  await getSchema();

  const server = serve({
    port: PORT,
    idleTimeout: 120,
    
    async fetch(req) {
      const url = new URL(req.url);
      
      if (url.pathname.startsWith('/api/')) {
        return handleAPI(req, url);
      }
      
      // Serve HTML
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html' }
      });
    }
  });

  console.log(`\n--- GGPK Explorer ---\n`);
  console.log(`[+] GGPK Explorer running at http://localhost:${PORT}\n`);
}
