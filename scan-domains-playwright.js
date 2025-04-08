#!/usr/bin/env node

/**
 * Playwright-based JS scanner with:
 *   - Upsert logic (domain is UNIQUE, re-scans overwrite old data)
 *   - Resource blocking (no images, fonts, etc.)
 *   - TWO queues:
 *       1) scanQueue (concurrency=N) for Playwright tasks
 *       2) dbQueue (concurrency=1) for DB writes to avoid nested transactions
 *   - Checkpoint file to skip domains already processed
 *
 * This prevents "cannot start a transaction within a transaction" in SQLite.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { program } from 'commander';
import PQueue from 'p-queue';
import pino from 'pino';
import sqlite3 from 'sqlite3';
import { chromium } from 'playwright';

import { 
	createDbHandlers
} from './db-handlers.js';

// Supported resource types
const RESOURCE_TYPES = ['script', 'stylesheet', 'fetch', 'xhr', 'image', 'font', 'media', 'websocket', 'manifest', 'other'];

import BrowserPool from './browser-pool.js';

/*
 * Setup & Defaults
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CHECKPOINT_FILE = path.join(__dirname, 'checkpoint.json');
const DEFAULT_DB_FILE = path.join(__dirname, 'results.db');

const logger = pino({
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
});

program
  .option('-i, --input <file>', 'File containing domains, one per line')
  .option('-d, --domain <domain>', 'Single domain to scan (ignore --input)')
  .option('--db <file>', 'SQLite DB file', DEFAULT_DB_FILE)
  .option('-c, --checkpoint <file>', 'Checkpoint file', DEFAULT_CHECKPOINT_FILE)
  .option('--resume', 'Resume from existing checkpoint')
  .option('--concurrency <number>', 'Number of concurrent scanning tasks', '5')
  .option('--pool-size <number>', 'Number of browser contexts to reuse', '5')
  .option('--max-retries <number>', 'Number of retries for a failing domain', '3')
  .option('--capture-types <types>', 'Comma-separated list of resource types to capture (script,stylesheet,fetch,xhr,image,font,media,websocket,manifest,other)', 'script')
  .option('--capture-all', 'Capture all resource types')
  .option('--external-only', 'Only capture resources from external domains', true)
  .option('--block-types <types>', 'Comma-separated list of resource types to block (image,font,stylesheet,media)', 'image,font,media')
  .option('--stdout', 'Output results to stdout instead of the database')
  .option('--output-format <format>', 'Format for stdout output: json, csv, or text', 'json')
  .option('--screenshot', 'Take screenshots of visited pages')
  .option('--screenshot-format <format>', 'Screenshot format: png or jpeg', 'png')
  .option('--screenshot-path <path>', 'Directory to save screenshots', './screenshots')
  .option('--screenshot-full-page', 'Capture full page screenshots, not just viewport')
  .option('--wait-until <state>', 'When to consider navigation complete: domcontentloaded, load, networkidle', 'domcontentloaded')
  .parse(process.argv);

const opts = program.opts();

/**
 * Ensure screenshot directory exists
 */
function ensureScreenshotDirectory(dir) {
  if (!fs.existsSync(dir)) {
    logger.info(`Creating screenshot directory: ${dir}`);
    fs.mkdirSync(dir, { recursive: true });
  }
}

/*
 * Signal Handling for Graceful Termination
 */

let isTerminating = false;
const cleanupTasks = [];

function registerCleanup(task) {
    cleanupTasks.push(task);
}

async function cleanupAndExit(signal) {
    if (isTerminating) return;  // Prevent double execution
    isTerminating = true;
    
    console.log(`Received ${signal} signal. Cleaning up resources...`);
    
    for (const task of cleanupTasks) {
        try {
            await task();
        } catch (err) {
            console.error("Error during cleanup:", err.message);
        }
    }

    // If it's SIGTERM (from timeout), exit with 124
    // If it's SIGINT (Ctrl+C), exit with 130
    const code = signal === 'SIGTERM' ? 124 : 130;
    process.exit(code);
}

process.on("SIGTERM", () => cleanupAndExit('SIGTERM'));
process.on("SIGINT", () => cleanupAndExit('SIGINT'));

process.on("exit", (code) => {
    console.log(`Process exited with code: ${code}`);
});

/*
 * Initialize SQLite (with UNIQUE domain)
 */

function initDb(dbPath) {
  const db = new sqlite3.Database(dbPath);
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL UNIQUE, 
        finalUrl TEXT,
        success INTEGER NOT NULL,  -- 1=success,0=fail
        error TEXT,
        screenshotPath TEXT,
        scannedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scanId INTEGER NOT NULL,
        url TEXT NOT NULL,
        resourceType TEXT NOT NULL,
        isExternal INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(scanId) REFERENCES scans(id)
      )
    `);
    
    // Handle migration from old schema if needed
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='externalScripts'", (err, row) => {
      if (row) {
        // The old table exists, migrate data
        logger.info('Migrating data from externalScripts to resources table...');
        db.run(`
          INSERT OR IGNORE INTO resources (scanId, url, resourceType, isExternal)
          SELECT scanId, scriptUrl, 'script', 1 FROM externalScripts
        `);
      }
    });
  });
  logger.info(`SQLite DB initialized at: ${dbPath}`);
  return db;
}

/*
 * Checkpoint
 */

function loadCheckpoint() {
  if (!opts.resume) {
    logger.info('No --resume flag; starting fresh (no checkpoint).');
    return new Set();
  }
  if (!fs.existsSync(opts.checkpoint)) {
    logger.info(`Checkpoint file not found: ${opts.checkpoint}; starting fresh.`);
    return new Set();
  }
  try {
    const data = JSON.parse(fs.readFileSync(opts.checkpoint, 'utf8'));
    if (!Array.isArray(data.processed)) {
      throw new Error('Invalid checkpoint format, expected { processed: string[] }');
    }
    logger.info(`Loaded checkpoint with ${data.processed.length} processed domains.`);
    return new Set(data.processed);
  } catch (err) {
    logger.warn(`Failed to parse checkpoint: ${err.message}. Starting fresh.`);
    return new Set();
  }
}

function writeCheckpoint(processedSet) {
  const data = {
    processed: Array.from(processedSet),
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(opts.checkpoint, JSON.stringify(data, null, 2), 'utf8');
  logger.info(`Wrote checkpoint. Processed so far: ${processedSet.size}`);
}

////////////////////////////////////////////////////////////////////////////////
// Scan Logic (No DB writes here!)
////////////////////////////////////////////////////////////////////////////////

async function scanDomain(domain, browserPool, maxRetries = 3, options = {}) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      return await doPlaywrightScan(domain, browserPool, options);
    } catch (err) {
      logger.warn({
        msg: 'Scan failed, will retry if attempts remain',
        domain,
        attempt,
        error: err.message,
      });
      if (attempt >= maxRetries) {
        return {
          domain,
          success: false,
          error: err.message,
          finalUrl: null,
          screenshotPath: null,
          resources: [],
        };
      }
    }
  }
}

/**
 * Actually load the page and gather resources.
 */
async function doPlaywrightScan(domain, browserPool, options = {}) {
  let raw = domain.trim();
  if (!/^https?:\/\//i.test(raw)) {
    raw = 'https://' + raw;
  }

  const urlObj = new URL(raw);
  const finalUrlToVisit = urlObj.toString();

  // Parse screenshot options
  const takeScreenshot = options.takeScreenshot || false;
  const screenshotFormat = options.screenshotFormat || 'png';
  const screenshotPath = options.screenshotPath || './screenshots';
  const fullPageScreenshot = options.fullPageScreenshot || false;
  
  // Parse navigation options
  const waitUntil = options.waitUntil || 'domcontentloaded';

  const context = await browserPool.acquireContext();
  const page = await context.newPage();

  // Parse capture types
  const captureAll = options.captureAll || false;
  const captureTypes = captureAll 
    ? RESOURCE_TYPES 
    : (options.captureTypes || 'script').split(',').map(t => t.trim());
  const externalOnly = options.externalOnly !== false;

  logger.info({
    msg: 'Scan configuration', 
    captureTypes, 
    externalOnly, 
    domain
  });

  // Store all requested resources by type
  const resourcesByType = new Map();
  captureTypes.forEach(type => resourcesByType.set(type, new Set()));

  // Track all requests
  page.on('requestfinished', (req) => {
    const type = req.resourceType();
    if (captureTypes.includes(type)) {
      const set = resourcesByType.get(type);
      if (set) set.add(req.url());
    }
  });

  try {
    logger.info(`Navigating to ${finalUrlToVisit} with waitUntil: ${waitUntil}`);
    await page.goto(finalUrlToVisit, {
      timeout: 30000, // Increased timeout for networkidle
      waitUntil: waitUntil,
    });
    const finalPageUrl = page.url();
    const finalHostname = new URL(finalPageUrl).hostname.toLowerCase();
    
    // Take screenshot if enabled
    let screenshotFilePath = null;
    if (takeScreenshot) {
      try {
        // Create a timestamped filename
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const sanitizedDomain = domain.replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `${sanitizedDomain}_${timestamp}.${screenshotFormat}`;
        screenshotFilePath = path.join(screenshotPath, filename);
        
        // Take the screenshot
        await page.screenshot({
          path: screenshotFilePath,
          fullPage: fullPageScreenshot,
          type: screenshotFormat
        });
        
        logger.info(`Screenshot saved to: ${screenshotFilePath}`);
      } catch (screenshotErr) {
        logger.error({
          msg: 'Failed to take screenshot',
          domain,
          error: screenshotErr.message
        });
        screenshotFilePath = null;
      }
    }

    // Collect additional DOM resources if needed
    if (captureTypes.includes('script')) {
      const domScripts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('script[src]')).map((el) => el.src)
      );
      domScripts.forEach(src => resourcesByType.get('script').add(src));
    }

    if (captureTypes.includes('stylesheet')) {
      const cssLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((el) => el.href)
      );
      cssLinks.forEach(href => resourcesByType.get('stylesheet').add(href));
    }
    
    // Process resources
    const resources = [];
    for (const [type, urls] of resourcesByType.entries()) {
      for (const url of urls) {
        try {
          const resourceHost = new URL(url).hostname.toLowerCase();
          const isExternal = resourceHost !== finalHostname;
          
          // Only add if external flag matches setting
          if (!externalOnly || isExternal) {
            resources.push({
              url,
              type,
              isExternal
            });
          }
        } catch (_) {
          // ignore parse errors
        }
      }
    }

    await page.close();
    browserPool.releaseContext(context);

    return {
      domain,
      success: true,
      error: null,
      finalUrl: finalPageUrl,
      screenshotPath: screenshotFilePath,
      resources,
    };
  } catch (err) {
    await page.close().catch(() => {});
    browserPool.releaseContext(context);
    throw err;
  }
}

/**
 * Process result and output to stdout in the specified format
 */
function handleStdoutOutput(result, format = 'json') {
  const { domain, success, error, finalUrl, resources } = result;
  
  if (!success) {
    console.error(`Failed to scan ${domain}: ${error}`);
    return;
  }
  
  switch (format.toLowerCase()) {
    case 'json':
      console.log(JSON.stringify(result, null, 2));
      break;
      
    case 'csv':
      // Print CSV header if this is the first result
      if (!handleStdoutOutput.headerPrinted) {
        console.log('domain,resource_url,resource_type,is_external,screenshot_path');
        handleStdoutOutput.headerPrinted = true;
      }
      
      // Print each resource as a CSV row
      if (resources && resources.length > 0) {
        resources.forEach(res => {
          console.log(`"${domain}","${res.url}","${res.type}",${res.isExternal ? '1' : '0'},"${result.screenshotPath || ''}"`);
        });
      } else {
        console.log(`"${domain}","no resources found","none",0,"${result.screenshotPath || ''}"`);
      }
      break;
      
    case 'text':
    default:
      console.log(`Domain: ${domain}`);
      console.log(`Final URL: ${finalUrl}`);
      console.log(`Resources: ${resources ? resources.length : 0}`);
      if (result.screenshotPath) {
        console.log(`Screenshot: ${result.screenshotPath}`);
      }
      
      if (resources && resources.length > 0) {
        console.log('\nResource List:');
        resources.forEach(res => {
          console.log(`- [${res.type}] ${res.isExternal ? 'EXTERNAL' : 'INTERNAL'}: ${res.url}`);
        });
      } else {
        console.log('No resources found.');
      }
      console.log('-------------------------------------------');
      break;
  }
}
// Static property to track if CSV header has been printed
handleStdoutOutput.headerPrinted = false;

/*
 * main function with two queues: scanQueue & dbQueue
 */

async function main() {
  const concurrency = parseInt(opts.concurrency, 10) || 5;
  const poolSize = parseInt(opts.poolSize, 10) || concurrency;
  const maxRetries = parseInt(opts.maxRetries, 10) || 3;

  // Parse resource type options
  const captureAll = !!opts.captureAll;
  const captureTypes = opts.captureTypes || 'script';
  const externalOnly = opts.externalOnly !== 'false';
  const blockTypes = opts.blockTypes ? opts.blockTypes.split(',').map(t => t.trim()) : ['image', 'font', 'media'];
  const useStdout = !!opts.stdout;
  const outputFormat = opts.outputFormat || 'json';
  
  // Screenshot options
  const takeScreenshot = !!opts.screenshot;
  const screenshotFormat = (opts.screenshotFormat || 'png').toLowerCase();
  const screenshotPath = opts.screenshotPath || './screenshots';
  const fullPageScreenshot = !!opts.screenshotFullPage;
  
  // Navigation options
  const waitUntil = opts.waitUntil || 'domcontentloaded';
  
  // Ensure screenshot directory exists if needed
  if (takeScreenshot) {
    ensureScreenshotDirectory(screenshotPath);
  }
  
  // Log configuration
  logger.info({
    msg: 'Starting scan with configuration',
    captureAll,
    captureTypes,
    externalOnly,
    blockTypes,
    concurrency,
    poolSize,
    maxRetries,
    useStdout,
    outputFormat,
    ...(takeScreenshot && {
      takeScreenshot,
      screenshotFormat,
      screenshotPath,
      fullPageScreenshot
    }),
    waitUntil
  });

  // Initialize DB only if not using stdout
  const db = useStdout ? null : initDb(opts.db);
  const processedDomains = loadCheckpoint();

  // Create DB handlers with the logger
  const { handleDbWrite } = createDbHandlers(logger);

  // For scanning concurrency (browser tasks)
  const scanQueue = new PQueue({ concurrency });

  // For DB writes concurrency=1 to avoid nested transactions
  const dbQueue = new PQueue({ concurrency: 1 });

  // We might run single-domain or file-based
  if (opts.domain) {
    if (!useStdout && processedDomains.has(opts.domain)) {
      logger.info(`Domain ${opts.domain} is already processed; skipping.`);
      if (db) db.close();
      return;
    }
    logger.info(`Scanning single domain: ${opts.domain}`);
    const browserPool = new BrowserPool(poolSize, logger, { blockTypes });
    await browserPool.init();

    // We'll do the scanning in the scanQueue
    scanQueue.add(async () => {
      const scanOptions = { 
        captureAll, 
        captureTypes, 
        externalOnly,
        takeScreenshot,
        screenshotFormat,
        screenshotPath,
        fullPageScreenshot,
        waitUntil
      };
      const result = await scanDomain(opts.domain, browserPool, maxRetries, scanOptions);
      
      if (useStdout) {
        // Output to stdout instead of DB
        handleStdoutOutput(result, outputFormat);
      } else {
        // Store in DB
        await dbQueue.add(() => handleDbWrite(db, result, processedDomains, writeCheckpoint));
      }
    });

    await scanQueue.onIdle();
    // Wait until DB jobs are done if not using stdout
    if (!useStdout) await dbQueue.onIdle();
    await browserPool.close();
    if (db) db.close();
    logger.info('Single-domain scan complete.');
    return;
  }

  // Otherwise, multi-domain
  if (!opts.input) {
    logger.error('Must specify --input <file> or --domain <domain>.');
    if (db) db.close();
    process.exit(1);
  }
  if (!fs.existsSync(opts.input)) {
    logger.error(`Input file not found: ${opts.input}`);
    if (db) db.close();
    process.exit(1);
  }

  const browserPool = new BrowserPool(poolSize, logger, { blockTypes });
  await browserPool.init();

  let totalCount = 0;
  let processedCount = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(opts.input),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const domain = line.trim();
    if (!domain) continue;
    totalCount++;

    if (!useStdout && processedDomains.has(domain)) {
      continue; // skip already processed domains only when using DB
    }

    // Add a scanning job to scanQueue
    scanQueue.add(async () => {
      const scanOptions = { 
        captureAll, 
        captureTypes, 
        externalOnly,
        takeScreenshot,
        screenshotFormat,
        screenshotPath,
        fullPageScreenshot,
        waitUntil
      };
      const result = await scanDomain(domain, browserPool, maxRetries, scanOptions);
      
      if (useStdout) {
        // Output to stdout
        handleStdoutOutput(result, outputFormat);
        processedCount++;
      } else {
        // Store in DB
        await dbQueue.add(() => handleDbWrite(db, result, processedDomains, writeCheckpoint));
      }
    });
  }

  await scanQueue.onIdle();  // Wait for all scanning to finish
  
  // Wait for all DB writes to finish if not using stdout
  if (!useStdout) {
    await dbQueue.onIdle();
  }

  await browserPool.close();
  if (db) db.close();

  if (useStdout) {
    logger.info(`
===== SCAN COMPLETE =====
Total domains in file:       ${totalCount}
Domains processed:           ${processedCount}
Output format:               ${outputFormat}
`);
  } else {
    logger.info(`
===== SCAN COMPLETE =====
Total domains in file:       ${totalCount}
Total domains in checkpoint: ${processedDomains.size}
Database path:               ${opts.db}
Checkpoint file:             ${opts.checkpoint}
`);
  }
}

main().catch((err) => {
  logger.fatal({ msg: 'Fatal error in main()', error: err.message });
  process.exit(1);
});

