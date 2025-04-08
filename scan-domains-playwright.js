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
  .parse(process.argv);

const opts = program.opts();

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
    await page.goto(finalUrlToVisit, {
      timeout: 10000,
      waitUntil: 'domcontentloaded',
    });
    const finalPageUrl = page.url();
    const finalHostname = new URL(finalPageUrl).hostname.toLowerCase();

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
      resources,
    };
  } catch (err) {
    await page.close().catch(() => {});
    browserPool.releaseContext(context);
    throw err;
  }
}

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
  
  // Log configuration
  logger.info({
    msg: 'Starting scan with configuration',
    captureAll,
    captureTypes,
    externalOnly,
    blockTypes,
    concurrency,
    poolSize,
    maxRetries
  });

  const db = initDb(opts.db);
  const processedDomains = loadCheckpoint();

  // Create DB handlers with the logger
  const { handleDbWrite } = createDbHandlers(logger);

  // For scanning concurrency (browser tasks)
  const scanQueue = new PQueue({ concurrency });

  // For DB writes concurrency=1 to avoid nested transactions
  const dbQueue = new PQueue({ concurrency: 1 });

  // We might run single-domain or file-based
  if (opts.domain) {
    if (processedDomains.has(opts.domain)) {
      logger.info(`Domain ${opts.domain} is already processed; skipping.`);
      db.close();
      return;
    }
    logger.info(`Scanning single domain: ${opts.domain}`);
    const browserPool = new BrowserPool(poolSize, logger, { blockTypes });
    await browserPool.init();

    // We'll do the scanning in the scanQueue
    scanQueue.add(async () => {
      const scanOptions = { captureAll, captureTypes, externalOnly };
      const result = await scanDomain(opts.domain, browserPool, maxRetries, scanOptions);
      // Now queue the DB update
      await dbQueue.add(() => handleDbWrite(db, result, processedDomains, writeCheckpoint));
    });

    await scanQueue.onIdle();
    // Wait until DB jobs are done
    await dbQueue.onIdle();
    await browserPool.close();
    db.close();
    logger.info('Single-domain scan complete.');
    return;
  }

  // Otherwise, multi-domain
  if (!opts.input) {
    logger.error('Must specify --input <file> or --domain <domain>.');
    db.close();
    process.exit(1);
  }
  if (!fs.existsSync(opts.input)) {
    logger.error(`Input file not found: ${opts.input}`);
    db.close();
    process.exit(1);
  }

  const browserPool = new BrowserPool(poolSize, logger, { blockTypes });
  await browserPool.init();

  let totalCount = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(opts.input),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const domain = line.trim();
    if (!domain) continue;
    totalCount++;

    if (processedDomains.has(domain)) {
      continue; // skip
    }

    // Add a scanning job to scanQueue
    scanQueue.add(async () => {
      const scanOptions = { captureAll, captureTypes, externalOnly };
      const result = await scanDomain(domain, browserPool, maxRetries, scanOptions);
      // Then enqueue a DB job
      await dbQueue.add(() => handleDbWrite(db, result, processedDomains, writeCheckpoint));
    });
  }

  await scanQueue.onIdle();  // Wait for all scanning to finish
  await dbQueue.onIdle();    // Wait for all DB writes to finish

  await browserPool.close();
  db.close();

  logger.info(`
===== SCAN COMPLETE =====
Total domains in file:       ${totalCount}
Total domains in checkpoint: ${processedDomains.size}
Database path:               ${opts.db}
Checkpoint file:             ${opts.checkpoint}
`);
}

main().catch((err) => {
  logger.fatal({ msg: 'Fatal error in main()', error: err.message });
  process.exit(1);
});

