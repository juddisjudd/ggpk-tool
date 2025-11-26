# POE2 GGPK Tool

A TypeScript/Bun tool for extracting and parsing assets from Path of Exile 2's Content.ggpk file.

https://github.com/user-attachments/assets/05ac2aa7-7f1b-4ca9-833a-c3f7069bd71d

## Features

- Extract files from bundled GGPK (114GB+ archives)
- Parse `.datc64` data files to JSON using [dat-schema](https://github.com/poe-tool-dev/dat-schema)
- Convert DDS textures to PNG/WebP
- Web-based GUI for browsing and extracting
- Automatic schema updates from GitHub
- Memory-efficient streaming extraction
- Language filtering (exclude non-English assets)

## Prerequisites

### 1. Bun Runtime

```powershell
# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

### 2. ooz Decompressor

The tool requires `bun_extract_file.exe` for Oodle decompression.

**Location:** `external/ooz/build/Release/bun_extract_file.exe`

**Download:** Clone and build from [zao/ooz](https://github.com/zao/ooz)

```bash
git clone https://github.com/zao/ooz external/ooz
cd external/ooz
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

### 3. Image Converters (Optional)

For DDS texture conversion, download and place in `external/texconv/`:

| Tool | Purpose | Download |
|------|---------|----------|
| `texconv.exe` | DDS to PNG conversion | [DirectXTex releases](https://github.com/Microsoft/DirectXTex/releases) |
| `cwebp.exe` | PNG to WebP conversion | [WebP downloads](https://storage.googleapis.com/downloads.webmproject.org/releases/webp/index.html) |

### 4. Install Dependencies

```bash
bun install
```

## Configuration

Create `config.json` in the project root:

```json
{
  "poe2Path": "C:/Program Files (x86)/Steam/steamapps/common/Path of Exile 2",
  "outputDir": "./extracted",
  "schemaPath": "./schema.min.json"
}
```

### Common Installation Paths

| Platform   | Path                                                              |
|------------|-------------------------------------------------------------------|
| Steam      | `C:/Program Files (x86)/Steam/steamapps/common/Path of Exile 2`   |
| Epic       | `C:/Program Files/Epic Games/PathOfExile2`                        |
| Standalone | `C:/Program Files (x86)/Grinding Gear Games/Path of Exile 2`      |

---

## GUI

Launch the web-based interface:

```bash
bun run src/index.ts gui
```

Options:
- `-p, --port <number>` - Port (default: 3000)
- `--open` - Open browser automatically
- `--no-schema-update` - Skip schema update check

The GUI provides:
- File browser with folder tree navigation
- Preview for images, audio, JSON, and DAT files
- Search functionality
- Batch extraction with progress tracking
- Schema management

---

## CLI Commands

### Bundle Commands

These commands work with POE2's bundled GGPK format.

#### `bundle-info`

Show GGPK summary (bundle count, file count).

```bash
bun run src/index.ts bundle-info
```

#### `bundle-list`

List files in the GGPK.

```bash
bun run src/index.ts bundle-list [options]

Options:
  -l, --limit <number>    Limit results (default: 100)
  -p, --pattern <regex>   Filter by regex pattern
```

#### `bundle-extract`

Extract files by pattern or specific paths.

```bash
bun run src/index.ts bundle-extract [options]

Options:
  -p, --pattern <regex>   Regex pattern to match files
  -f, --files <paths...>  Specific file paths
  -o, --output <dir>      Output directory (default: ./extracted)
```

#### `bundle-category`

Extract predefined categories.

```bash
bun run src/index.ts bundle-category <category> [options]

Categories:
  data       .datc64 files
  textures   .dds files
  audio      .ogg, .wav, .bank files
  models     .sm, .fmt, .ao, .ast files
  ui         art/2dart/*
  skills     metadata/effects/spells/*
  items      art/2ditems/*
  passives   art/2dart/skillicons/passives/*

Options:
  -o, --output <dir>      Output directory (default: ./extracted)
  --all-languages         Include non-English language files
```

### Data Parsing Commands

#### `parse-dat`

Parse a single .datc64 file to JSON.

```bash
bun run src/index.ts parse-dat -f <file> [-o <output>]
```

#### `parse-all-dat`

Parse all .datc64 files in a directory.

```bash
bun run src/index.ts parse-all-dat [options]

Options:
  -i, --input <dir>       Input directory (default: ./extracted/data)
  -o, --output <dir>      Output directory (default: ./parsed)
  --filter <string>       Filter tables by name
  --pretty                Pretty print JSON
  --limit <number>        Limit files to parse
  --sequential            Single-threaded (default: parallel)
  --no-cache              Force re-parse
```

#### `list-tables`

List all available DAT tables with schemas.

```bash
bun run src/index.ts list-tables
```

### Utility Commands

#### `update-schema`

Update the DAT schema from GitHub.

```bash
bun run src/index.ts update-schema [-f, --force]
```

#### `convert-dds`

Convert DDS textures to PNG or WebP.

```bash
bun run src/index.ts convert-dds [options]

Options:
  -i, --input <dir>       Input directory
  -o, --output <dir>      Output directory
  -f, --format <fmt>      Output format: png, webp (default: webp)
  -q, --quality <n>       Quality 0-100 (default: 85)
```

#### `config show`

Display current configuration.

```bash
bun run src/index.ts config show
```

---

## Project Structure

```
ggpk-tool/
├── src/
│   ├── index.ts           # CLI entry point
│   ├── config.ts          # Configuration loader
│   ├── dat/               # DAT file parsing
│   ├── ggpk/              # GGPK reading and extraction
│   ├── gui/               # Web GUI server
│   ├── tasks/             # CLI task implementations
│   └── utils/             # Utilities (logger, image converter, etc.)
├── external/
│   ├── ooz/               # Oodle decompressor (build required)
│   └── texconv/           # DDS converter (optional)
├── extracted/             # Default output directory
├── config.json            # User configuration
└── schema.min.json        # DAT schema (auto-updated)
```

## Credits

This project builds on the work of several open-source projects:

- [zao/ooz](https://github.com/zao/ooz) - Oodle decompression library
- [poe-tool-dev/dat-schema](https://github.com/poe-tool-dev/dat-schema) - Data file schema definitions
- [SnosMe/poe-dat-viewer](https://github.com/SnosMe/poe-dat-viewer) - DAT file parsing reference
- [Project-Path-of-Exile-Wiki/PyPoE](https://github.com/Project-Path-of-Exile-Wiki/PyPoE) - PoE data extraction reference
- [Microsoft/DirectXTex](https://github.com/Microsoft/DirectXTex) - DDS texture conversion

## License

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.en.html)
