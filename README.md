# Web Domain Scanner

A high-performance, concurrent web scraper for extracting external resources from websites.

## Overview

This tool visits websites and identifies external resources loaded by each domain. It can capture various resource types including scripts, stylesheets, XHR, fetch requests, and more. It's optimized for:

- **Bulk scanning**: Process thousands of domains from input files
- **Concurrency**: Configurable browser and DB task parallelization
- **Resource efficiency**: Blocks unnecessary resources (images, fonts, stylesheets)
- **Reliability**: Robust error handling and retries for failed scans

For more details, see the related blog post: [Examining External Dependencies in Web Applications](https://blog.fraktal.fi/examining-external-dependencies-in-web-applications-0846894cecdd)

## Features

- **Flexible resource capture**: Collect scripts, stylesheets, XHR, fetch requests, images, and more
- **Configurable filtering**: Choose between external-only or all resources 
- **Browser automation**: Uses Playwright for headless Chrome browsing
- **Optimized browser pool**: Reuses browser contexts to reduce memory usage
- **Resource blocking**: Configurable blocking of unnecessary resources (images, fonts, etc.) for speed
- **Database storage**: Persistent SQLite storage with transaction support
- **Checkpointing**: Resume interrupted scans from last successful position
- **Upsert logic**: Domain uniqueness with automatic overwrite of previous scans
- **Configurable concurrency**: Tune performance for available hardware
- **Batch processing**: Process large domain lists in manageable chunks

## Requirements

- Node.js (v14.8.0+)
- SQLite

## Installation

### Clone and Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/scraper.git
cd scraper

# Install dependencies
npm install

# Install Playwright browsers
npx playwright install-deps
npx playwright install chromium
```

### Manual Setup (without git)

If you're setting up the project manually, follow these steps:

1. Create the project directory and files:
```bash
mkdir web-domain-scanner
cd web-domain-scanner
```

2. Create the package.json file:
```bash
cat > package.json << 'EOF'
{
  "name": "web-domain-scanner",
  "version": "1.0.0",
  "description": "A high-performance web scraper for extracting external JavaScript sources from websites",
  "type": "module",
  "main": "scan-domains-playwright.js",
  "scripts": {
    "scan": "node scan-domains-playwright.js",
    "batch-scan": "bash batch-run.sh"
  },
  "dependencies": {
    "commander": "^11.0.0",
    "p-queue": "^7.3.4",
    "pino": "^8.14.1",
    "playwright": "^1.35.1",
    "sqlite3": "^5.1.6"
  },
  "engines": {
    "node": ">=14.8.0"
  }
}
EOF
```

3. Download the source files from the repository, or create them as described in the Source Files section below.

4. Install dependencies and Playwright:
```bash
npm install
npx playwright install-deps
npx playwright install chromium
```

## Directory Structure

Create the following directory structure for batch scanning:

```
web-domain-scanner/
├── batch-run.sh
├── browser-pool.js
├── db-handlers.js
├── package.json
├── scan-domains-playwright.js
├── input/
│   └── domains.txt
└── results/
```

## Usage

### Single Domain Scan

```bash
# Using the CLI directly
node scan-domains-playwright.js --domain example.com

# Using npm script
npm run scan -- --domain example.com
```

### Batch Scanning

Create an `input` directory containing text files with one domain per line:

```bash
mkdir -p input
echo "example.com" > input/domains.txt
echo "github.com" >> input/domains.txt
```

Then run the batch script:

```bash
# Using the script directly
./batch-run.sh

# Using npm script
npm run batch-scan
```

The batch script is recommended for large scans as it breaks input into chunks and uses timeout protection to prevent hangs during extensive crawling.

### CLI Options

```
Options:
  -i, --input <file>           File containing domains, one per line
  -d, --domain <domain>        Single domain to scan (ignore --input)
  --db <file>                  SQLite DB file (default: ./results.db)
  -c, --checkpoint <file>      Checkpoint file (default: ./checkpoint.json)
  --resume                     Resume from existing checkpoint
  --concurrency <number>       Number of concurrent scanning tasks (default: 5)
  --pool-size <number>         Number of browser contexts to reuse (default: 5)
  --max-retries <number>       Number of retries for a failing domain (default: 3)
  --capture-types <types>      Comma-separated list of resource types to capture (default: "script")
                               Available types: script,stylesheet,fetch,xhr,image,font,media,websocket,manifest,other
  --capture-all                Capture all resource types
  --external-only <boolean>    Only capture resources from external domains (default: true)
  --block-types <types>        Comma-separated list of resource types to block, use "none" to allow all (default: "image,font,media")
  --stdout                     Output results to stdout instead of the database
  --output-format <format>     Format for stdout output: json, csv, or text (default: "json")
  --screenshot                 Take screenshots of visited pages
  --screenshot-format <format> Screenshot format: png or jpeg (default: "png")
  --screenshot-path <path>     Directory to save screenshots (default: "./screenshots")
  --screenshot-full-page       Capture full page screenshots, not just viewport
  --wait-until <state>         When to consider navigation complete: domcontentloaded, load, networkidle (default: "domcontentloaded")
  --check-sri                  Check for Subresource Integrity (SRI) attributes on scripts and stylesheets
  --track-dependencies         Track resource dependencies to identify fourth-party resources
  -h, --help                   Display help information
```

### Usage Examples

```bash
# Resource Capture Examples

# Capture both scripts and stylesheets
node scan-domains-playwright.js --domain example.com --capture-types "script,stylesheet"

# Capture all resource types
node scan-domains-playwright.js --domain example.com --capture-all

# Include internal resources (same domain)
node scan-domains-playwright.js --domain example.com --external-only false

# Block only images when scanning
node scan-domains-playwright.js --domain example.com --block-types "image"

# Output Examples

# Output to stdout in JSON format instead of saving to database
node scan-domains-playwright.js --domain example.com --stdout

# Output to stdout in CSV format
node scan-domains-playwright.js --domain example.com --stdout --output-format csv

# Output to stdout in text format
node scan-domains-playwright.js --domain example.com --stdout --output-format text

# Pipe output to a file
node scan-domains-playwright.js --domain example.com --stdout > results.json

# Process multiple domains and output as CSV
node scan-domains-playwright.js --input domains.txt --stdout --output-format csv > results.csv

# Screenshot Examples

# Take screenshots while scanning
node scan-domains-playwright.js --domain example.com --screenshot

# Take full page screenshots in JPEG format
node scan-domains-playwright.js --domain example.com --screenshot --screenshot-format jpeg --screenshot-full-page

# Customize screenshot directory
node scan-domains-playwright.js --domain example.com --screenshot --screenshot-path ./images

# Combine with stdout output
node scan-domains-playwright.js --domain example.com --stdout --screenshot

# Wait for all network activity to finish before capturing
node scan-domains-playwright.js --domain example.com --screenshot --wait-until networkidle

# Full capture with all options
node scan-domains-playwright.js --domain example.com --screenshot --screenshot-full-page --wait-until networkidle --capture-all

# Allow all resource types (no blocking)
node scan-domains-playwright.js --domain example.com --block-types none

# Security Checks

# Check for missing Subresource Integrity (SRI) attributes
node scan-domains-playwright.js --domain example.com --check-sri

# Combine SRI check with other features
node scan-domains-playwright.js --domain example.com --check-sri --stdout --output-format text

# Full security scan with network idle wait and SRI checking
node scan-domains-playwright.js --domain example.com --wait-until networkidle --check-sri

# Dependency Analysis

# Track fourth-party dependencies
node scan-domains-playwright.js --domain example.com --track-dependencies

# Comprehensive security and dependency scan
node scan-domains-playwright.js --domain example.com --wait-until networkidle --check-sri --track-dependencies

# Export dependency information to CSV
node scan-domains-playwright.js --domain example.com --track-dependencies --stdout --output-format csv > dependencies.csv
```

## Architecture

The tool is built around a dual-queue system:
1. **scanQueue**: Manages browser automation tasks with configurable concurrency
2. **dbQueue**: Handles database operations with concurrency=1 to avoid nested transactions

It uses a browser pool to efficiently reuse browser contexts, reducing memory usage and improving performance.

## Database Schema

The SQLite database contains two tables:

### `scans`
- `id`: Integer primary key
- `domain`: TEXT UNIQUE (the domain being scanned)
- `finalUrl`: TEXT (the URL after any redirects)
- `success`: INTEGER (1=success, 0=failure)
- `error`: TEXT (error message if scan failed)
- `screenshotPath`: TEXT (path to the screenshot file if taken)
- `scannedAt`: DATETIME (timestamp of scan)

### `resources`
- `id`: Integer primary key
- `scanId`: INTEGER (foreign key to scans.id)
- `url`: TEXT (URL of the resource)
- `resourceType`: TEXT (type of resource: script, stylesheet, image, etc.)
- `isExternal`: INTEGER (1=external domain, 0=same domain)
- `hasSri`: INTEGER (1=has integrity attribute, 0=missing integrity attribute, NULL=not applicable)

## Troubleshooting

### Common Issues

1. **Browser Launch Failures**
   - Ensure you've installed Playwright dependencies: `npx playwright install-deps`
   - For Linux systems, additional dependencies may be required

2. **Timeout Errors**
   - Adjust the concurrency settings for your hardware
   - For large scans, use the batch script which includes timeout protection

3. **Database Locking Errors**
   - If you encounter SQLite locking errors, it usually means another process is accessing the database
   - Wait for other processes to complete or use a different database file path

## License

See the [LICENSE](LICENSE) file for details.