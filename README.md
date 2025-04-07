# Web Domain Scanner

A high-performance, concurrent web scraper for extracting external JavaScript sources from websites.

## Overview

This tool visits websites and identifies all external JavaScript resources loaded by each domain. It's optimized for:

- **Bulk scanning**: Process thousands of domains from input files
- **Concurrency**: Configurable browser and DB task parallelization
- **Resource efficiency**: Blocks unnecessary resources (images, fonts, stylesheets)
- **Reliability**: Robust error handling and retries for failed scans

For more details, see the related blog post: [Examining External Dependencies in Web Applications](https://blog.fraktal.fi/examining-external-dependencies-in-web-applications-0846894cecdd)

## Features

- **Browser automation**: Uses Playwright for headless Chrome browsing
- **Optimized browser pool**: Reuses browser contexts to reduce memory usage
- **Resource blocking**: Prevents unnecessary resource loading for speed
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
  -i, --input <file>        File containing domains, one per line
  -d, --domain <domain>     Single domain to scan (ignore --input)
  --db <file>               SQLite DB file (default: ./results.db)
  -c, --checkpoint <file>   Checkpoint file (default: ./checkpoint.json)
  --resume                  Resume from existing checkpoint
  --concurrency <number>    Number of concurrent scanning tasks (default: 5)
  --pool-size <number>      Number of browser contexts to reuse (default: 5)
  --max-retries <number>    Number of retries for a failing domain (default: 3)
  -h, --help                Display help information
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
- `scannedAt`: DATETIME (timestamp of scan)

### `externalScripts`
- `id`: Integer primary key
- `scanId`: INTEGER (foreign key to scans.id)
- `scriptUrl`: TEXT (URL of the external script)

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