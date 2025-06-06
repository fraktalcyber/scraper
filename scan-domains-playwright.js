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
  .option('--block-types <types>', 'Comma-separated list of resource types to block (image,font,stylesheet,media), use "none" to allow all types', 'image,font,media')
  .option('--stdout', 'Output results to stdout instead of the database')
  .option('--output-format <format>', 'Format for stdout output: json, csv, or text', 'json')
  .option('--screenshot', 'Take screenshots of visited pages')
  .option('--screenshot-format <format>', 'Screenshot format: png or jpeg', 'png')
  .option('--screenshot-path <path>', 'Directory to save screenshots', './screenshots')
  .option('--screenshot-full-page', 'Capture full page screenshots, not just viewport')
  .option('--wait-until <state>', 'When to consider navigation complete: domcontentloaded, load, networkidle', 'domcontentloaded')
  .option('--check-sri', 'Check for Subresource Integrity (SRI) attributes on scripts and stylesheets')
  .option('--track-dependencies', 'Track resource dependencies to identify fourth-party resources')
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
        hasSri INTEGER,
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
          ...(options.checkSri && {
            sri: {
              checked: true,
              resourcesWithoutSri: { scripts: [], stylesheets: [] }
            }
          }),
          ...(options.trackDependencies && {
            dependencies: {
              checked: true,
              tree: {
                firstParty: [],
                thirdParty: {},
                fourthParty: {}
              }
            }
          })
        };
      }
    }
  }
}

/**
 * Tracks resource dependencies to identify fourth-party resources
 */
async function trackResourceDependencies(page, domain, captureTypes = null) {
  // Initialize structure to hold request data
  const requests = [];
  const domainToResources = new Map();
  const resourceTiming = new Map();
  const domCreators = new Map(); // Maps URLs to info about scripts that created them
  const dependencyTree = {
    firstParty: [],
    thirdParty: {}, // Map of third-party domains to their resources
    fourthParty: {}, // Map of third-party to fourth-party domains and resources
    dynamicCreation: {} // Maps resources to the scripts that created them
  };
  
  // Track all network requests with timing
  const startTime = Date.now();
  
  // Inject script to monitor DOM mutations for script/resource creation
  await page.addInitScript(() => {
    // Store which script created which resource
    window.__resourceCreators = new Map();
    window.__pendingElements = new Set();
    
    // Helper to get a simplified stack trace
    function getCallerInfo() {
      const error = new Error();
      const stack = error.stack || '';
      const lines = stack.split('\n').slice(3); // Skip the Error and helper function frames
      
      // Extract URLs from the stack trace
      const scriptUrls = [];
      for (const line of lines) {
        const urlMatch = line.match(/https?:\/\/[^:)]+/);
        if (urlMatch) {
          const url = urlMatch[0];
          // Don't include the current page URL
          if (url !== window.location.href) {
            scriptUrls.push(url);
          }
        }
      }
      
      return {
        timestamp: Date.now(),
        scriptUrls: scriptUrls.length > 0 ? scriptUrls : ['inline-script-or-event-handler']
      };
    }
    
    // Watch for dynamically added scripts and resources
    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              let url = null;
              
              // Handle different resource types
              if (node.tagName === 'SCRIPT' && node.src) {
                url = node.src;
              } else if (node.tagName === 'LINK' && node.rel === 'stylesheet' && node.href) {
                url = node.href;
              } else if (node.tagName === 'IMG' && node.src) {
                url = node.src;
              } else if (node.tagName === 'IFRAME' && node.src) {
                url = node.src;
              }
              
              if (url) {
                const info = getCallerInfo();
                window.__resourceCreators.set(url, info);
                
                // Track elements that haven't loaded yet
                window.__pendingElements.add(url);
                
                // Listen for load/error events to update status
                const markLoaded = () => {
                  window.__pendingElements.delete(url);
                  if (node.removeEventListener) {
                    node.removeEventListener('load', markLoaded);
                    node.removeEventListener('error', markLoaded);
                  }
                };
                
                if (node.addEventListener) {
                  node.addEventListener('load', markLoaded);
                  node.addEventListener('error', markLoaded);
                }
              }
            }
          }
        }
      }
    });
    
    observer.observe(document, { childList: true, subtree: true });
    
    // Intercept document.write and similar methods
    const originalWrite = document.write;
    document.write = function(...args) {
      const info = getCallerInfo();
      if (!window.__documentWrites) {
        window.__documentWrites = [];
      }
      window.__documentWrites.push({
        content: args.join(''),
        info
      });
      return originalWrite.apply(this, args);
    };
    
    // Intercept createElement + appendChild pattern
    const originalCreateElement = document.createElement;
    document.createElement = function(tagName) {
      const element = originalCreateElement.apply(this, arguments);
      const info = getCallerInfo();
      
      // Tag the element with creator info
      element.__creatorInfo = info;
      
      // Intercept setting src/href attributes
      if (element.tagName === 'SCRIPT' || element.tagName === 'LINK' || 
          element.tagName === 'IMG' || element.tagName === 'IFRAME') {
        
        const descriptors = {
          src: Object.getOwnPropertyDescriptor(element.__proto__, 'src'),
          href: Object.getOwnPropertyDescriptor(element.__proto__, 'href')
        };
        
        // Handle src attribute
        if (descriptors.src) {
          Object.defineProperty(element, 'src', {
            get: function() {
              return descriptors.src.get.call(this);
            },
            set: function(value) {
              const result = descriptors.src.set.call(this, value);
              if (value) {
                window.__resourceCreators.set(value, element.__creatorInfo || getCallerInfo());
              }
              return result;
            }
          });
        }
        
        // Handle href attribute
        if (descriptors.href) {
          Object.defineProperty(element, 'href', {
            get: function() {
              return descriptors.href.get.call(this);
            },
            set: function(value) {
              const result = descriptors.href.set.call(this, value);
              if (value && element.rel === 'stylesheet') {
                window.__resourceCreators.set(value, element.__creatorInfo || getCallerInfo());
              }
              return result;
            }
          });
        }
      }
      
      return element;
    };
  });
  
  // Listen for all requests and collect their order and timing
  page.on('request', request => {
    try {
      const url = request.url();
      const timestamp = Date.now() - startTime;
      const resourceType = request.resourceType();
      
      // Skip data URLs
      if (url.startsWith('data:')) return;
      
      // If captureTypes is specified, only track those resource types
      if (captureTypes && !captureTypes.includes(resourceType)) {
        return;
      }
      
      // Add to requests list
      requests.push({
        url,
        timestamp,
        resourceType
      });
      
      // Track timing
      resourceTiming.set(url, timestamp);
      
      // Group by domain
      try {
        const resourceDomain = new URL(url).hostname;
        if (!domainToResources.has(resourceDomain)) {
          domainToResources.set(resourceDomain, []);
        }
        domainToResources.get(resourceDomain).push({
          url,
          timestamp,
          resourceType
        });
      } catch (e) {
        // Skip invalid URLs
      }
    } catch (e) {
      // Skip any errors in request tracking
    }
  });
  
  // Add a completion handler to build the dependency tree after page load
  return {
    buildDependencyTree: async () => {
      // Get base domain from primary domain
      let baseDomain = new URL(domain.startsWith('http') ? domain : `https://${domain}`).hostname;
      
      // Normalize domain name (remove 'www.' prefix if present)
      const normalizedBaseDomain = baseDomain.replace(/^www\./, '');
      
      // Function to check if a domain is the same as the base domain (with www. normalization)
      const isSameAsBaseDomain = (testDomain) => {
        const normalizedTestDomain = testDomain.replace(/^www\./, '');
        return normalizedTestDomain === normalizedBaseDomain;
      };
      
      // Sort all requests by timestamp
      requests.sort((a, b) => a.timestamp - b.timestamp);
      
      // Retrieve DOM creation data
      const domCreationInfo = await page.evaluate(() => {
        return {
          resourceCreators: Array.from(window.__resourceCreators || new Map()).map(([url, info]) => ({
            url,
            createdBy: info.scriptUrls,
            timestamp: info.timestamp
          })),
          documentWrites: window.__documentWrites || []
        };
      });
      
      // Process DOM creation info
      domCreationInfo.resourceCreators.forEach(item => {
        domCreators.set(item.url, item);
      });
      
      // Identify first-party and third-party resources
      for (const [resourceDomain, resources] of domainToResources.entries()) {
        if (isSameAsBaseDomain(resourceDomain)) {
          // This is a first-party resource
          dependencyTree.firstParty = [...resources];
        } else {
          // This is a third-party resource
          dependencyTree.thirdParty[resourceDomain] = [...resources];
        }
      }
      
      // Identify potential fourth-party resources by analyzing load order and DOM creation
      // A resource is likely a fourth-party if it loads shortly after a third-party resource
      // or if DOM tracking confirms it was created by a third-party script
      const DEPENDENCY_THRESHOLD_MS = 300; // Reduced time window to minimize false positives
      
      // First pass: Use DOM creation information to establish high-confidence dependencies
      const confirmedFourthPartyByThirdParty = new Map();
      
      // Start by processing the DOM creation info for confirmed relationships
      domCreationInfo.resourceCreators.forEach(item => {
        try {
          // Skip if URL is malformed or it's a data URL
          const url = new URL(item.url);
          if (url.href.startsWith('data:')) return;
          
          // Skip first-party resources
          const resourceDomain = url.hostname;
          if (isSameAsBaseDomain(resourceDomain)) return;
          
          // Check if this resource was created by a third-party script
          if (item.createdBy && item.createdBy.length > 0 && item.createdBy[0] !== 'inline-script-or-event-handler') {
            // Try to find the third-party domain that created this resource
            for (const creatorUrl of item.createdBy) {
              try {
                const creatorDomain = new URL(creatorUrl).hostname;
                
                // Skip if creator is first-party or same as resource
                if (isSameAsBaseDomain(creatorDomain) || creatorDomain === resourceDomain) continue;
                
                // We found a third-party to fourth-party relationship
                if (!confirmedFourthPartyByThirdParty.has(creatorDomain)) {
                  confirmedFourthPartyByThirdParty.set(creatorDomain, new Map());
                }
                
                const fourthPartyMap = confirmedFourthPartyByThirdParty.get(creatorDomain);
                if (!fourthPartyMap.has(resourceDomain)) {
                  fourthPartyMap.set(resourceDomain, []);
                }
                
                // Find the resource in our requests list to get full details
                const resourceDetail = requests.find(req => req.url === item.url);
                if (resourceDetail) {
                  fourthPartyMap.get(resourceDomain).push({
                    ...resourceDetail,
                    possibleParent: creatorUrl,
                    createdBy: item.createdBy,
                    creationConfidence: 'high' // DOM-confirmed
                  });
                }
                
                break; // We found a creator, no need to check others
              } catch (e) {
                // Skip invalid creator URLs
                continue;
              }
            }
          }
        } catch (e) {
          // Skip invalid URLs
        }
      });
      
      // Second pass: Use timing information for medium-confidence dependencies
      for (const thirdPartyDomain in dependencyTree.thirdParty) {
        const thirdPartyResources = dependencyTree.thirdParty[thirdPartyDomain];
        dependencyTree.fourthParty[thirdPartyDomain] = {};
        
        // First add any confirmed fourth-party resources for this third-party
        if (confirmedFourthPartyByThirdParty.has(thirdPartyDomain)) {
          const confirmedFourthParties = confirmedFourthPartyByThirdParty.get(thirdPartyDomain);
          for (const [fourthPartyDomain, resources] of confirmedFourthParties.entries()) {
            dependencyTree.fourthParty[thirdPartyDomain][fourthPartyDomain] = [...resources];
          }
        }
        
        // Then use timing information for additional potential dependencies
        for (const thirdPartyResource of thirdPartyResources) {
          // Look for resources loaded shortly after this third-party resource
          const potentialDependencies = requests.filter(req => {
            try {
              const reqDomain = new URL(req.url).hostname;
              
              // Check if the parent resource is capable of loading other resources
              // Files like images, videos, fonts typically don't load other resources
              const parentType = thirdPartyResource.resourceType;
              const parentUrl = thirdPartyResource.url;
              const isParentCapable = 
                parentType === 'script' || 
                parentType === 'document' || 
                parentType === 'iframe' || 
                parentType === 'xhr' || 
                parentType === 'fetch';
                
              // Check if parent URL is a non-executable media file
              const parentIsMedia = /\.(jpg|jpeg|png|gif|webp|mp4|webm|ogg|mp3|wav|pdf|woff|woff2|ttf|eot)$/i.test(parentUrl);
              
              return (
                reqDomain !== thirdPartyDomain && // Not the same third-party
                !isSameAsBaseDomain(reqDomain) && // Not first-party
                req.timestamp > thirdPartyResource.timestamp && // Loaded after
                req.timestamp < thirdPartyResource.timestamp + DEPENDENCY_THRESHOLD_MS && // Within time threshold
                req.timestamp - thirdPartyResource.timestamp >= 5 && // At least 5ms difference to avoid coincidental loads
                isParentCapable && // Parent resource must be capable of loading other resources
                !parentIsMedia // Parent is not a media file
              );
            } catch (e) {
              return false;
            }
          });
          
          // Group potential timing-based dependencies by domain
          for (const dependency of potentialDependencies) {
            try {
              const dependencyDomain = new URL(dependency.url).hostname;
              
              // Skip domain resources loaded by third-parties - these are still first-party resources
              // They should appear in the first-party section, not as fourth-party
              if (isSameAsBaseDomain(dependencyDomain)) {
                // Add to first-party if not already there
                const alreadyInFirstParty = dependencyTree.firstParty.some(
                  r => r.url === dependency.url
                );
                
                if (!alreadyInFirstParty) {
                  dependencyTree.firstParty.push(dependency);
                }
                continue;
              }
              
              // Skip if we already have a confirmed high-confidence relationship for this resource
              const confirmedFourthParties = confirmedFourthPartyByThirdParty.get(thirdPartyDomain);
              if (confirmedFourthParties && 
                  confirmedFourthParties.has(dependencyDomain) && 
                  confirmedFourthParties.get(dependencyDomain).some(r => r.url === dependency.url)) {
                continue;
              }
              
              // Handle timing-based fourth-party resources (not from base domain)
              if (!dependencyTree.fourthParty[thirdPartyDomain][dependencyDomain]) {
                dependencyTree.fourthParty[thirdPartyDomain][dependencyDomain] = [];
              }
              
              // Check if we have DOM creation info for this dependency
              const creationInfo = domCreators.get(dependency.url);
              const enhancedDependency = {
                ...dependency,
                possibleParent: thirdPartyResource.url
              };
              
              // If we have DOM creation info, use it
              if (creationInfo) {
                enhancedDependency.createdBy = creationInfo.createdBy;
                enhancedDependency.creationConfidence = 'high'; // DOM-detected
              } else {
                enhancedDependency.creationConfidence = 'medium'; // Timing-inferred
              }
              
              dependencyTree.fourthParty[thirdPartyDomain][dependencyDomain].push(enhancedDependency);
            } catch (e) {
              // Skip invalid URLs
            }
          }
        }
        
        // Remove empty fourth-party entries
        if (Object.keys(dependencyTree.fourthParty[thirdPartyDomain]).length === 0) {
          delete dependencyTree.fourthParty[thirdPartyDomain];
        }
      }
      
      // Add direct DOM creation info to the tree
      dependencyTree.dynamicCreation = {};
      domCreationInfo.resourceCreators.forEach(item => {
        try {
          // Skip if URL is malformed
          const url = new URL(item.url);
          // Only include if it's not a data URL
          if (!url.href.startsWith('data:')) {
            dependencyTree.dynamicCreation[item.url] = {
              createdBy: item.createdBy,
              timestamp: item.timestamp
            };
            
            // If this is a first-party resource loaded by third-party script,
            // ensure it appears in the first-party resources list
            if (isSameAsBaseDomain(url.hostname)) {
              const resourceType = item.url.endsWith('.js') ? 'script' : 
                                 item.url.endsWith('.css') ? 'stylesheet' : 'other';
                                 
              // Add to first-party if not already there
              const alreadyInFirstParty = dependencyTree.firstParty.some(
                r => r.url === item.url
              );
              
              if (!alreadyInFirstParty) {
                dependencyTree.firstParty.push({
                  url: item.url,
                  timestamp: item.timestamp,
                  resourceType
                });
              }
            }
          }
        } catch (e) {
          // Skip invalid URLs
        }
      });
      
      return dependencyTree;
    }
  };
}

/**
 * Checks if resources have SRI (Subresource Integrity) attributes
 */
async function checkSriAttributes(page) {
  // Get scripts and stylesheets without integrity attributes
  const resourcesWithoutSri = await page.evaluate(() => {
    const results = {
      scripts: [],
      stylesheets: []
    };
    
    // Check scripts
    document.querySelectorAll('script[src]').forEach(script => {
      const src = script.getAttribute('src');
      const integrity = script.getAttribute('integrity');
      if (!integrity && src) {
        results.scripts.push({
          src,
          element: 'script',
          hasIntegrity: false
        });
      }
    });
    
    // Check stylesheets
    document.querySelectorAll('link[rel="stylesheet"][href]').forEach(link => {
      const href = link.getAttribute('href');
      const integrity = link.getAttribute('integrity');
      if (!integrity && href) {
        results.stylesheets.push({
          src: href,
          element: 'stylesheet',
          hasIntegrity: false
        });
      }
    });
    
    return results;
  });
  
  return resourcesWithoutSri;
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
  
  // Parse security check options
  const checkSri = options.checkSri || false;
  const trackDependencies = options.trackDependencies || false;

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
  
  // Set up dependency tracking if enabled
  let dependencyTracker = null;
  if (trackDependencies) {
    // If capture types are specified, use them for dependency tracking too
    const typesToTrack = captureAll ? RESOURCE_TYPES : captureTypes;
    dependencyTracker = await trackResourceDependencies(page, domain, typesToTrack);
  }

  try {
    logger.info(`Navigating to ${finalUrlToVisit} with waitUntil: ${waitUntil}`);
    await page.goto(finalUrlToVisit, {
      timeout: 30000, // Increased timeout for networkidle
      waitUntil: waitUntil,
    });
    const finalPageUrl = page.url();
    const finalHostname = new URL(finalPageUrl).hostname.toLowerCase();
    
    // Check for SRI attributes if enabled
    let resourcesWithoutSri = null;
    if (checkSri) {
      resourcesWithoutSri = await checkSriAttributes(page);
      logger.info({
        msg: 'SRI check results',
        domain,
        scriptsWithoutSri: resourcesWithoutSri.scripts.length,
        stylesheetsWithoutSri: resourcesWithoutSri.stylesheets.length
      });
    }
    
    // Process dependency information if enabled
    let dependencyResults = null;
    if (trackDependencies && dependencyTracker) {
      dependencyResults = await dependencyTracker.buildDependencyTree();
      
      // Log a summary of the dependency tree
      const thirdPartyDomains = Object.keys(dependencyResults.thirdParty);
      const fourthPartyDomains = new Set();
      Object.values(dependencyResults.fourthParty).forEach(domains => {
        Object.keys(domains).forEach(domain => fourthPartyDomains.add(domain));
      });
      
      logger.info({
        msg: 'Dependency results',
        domain,
        firstPartyResources: dependencyResults.firstParty.length,
        thirdPartyDomains: thirdPartyDomains.length,
        fourthPartyDomains: fourthPartyDomains.size
      });
    }
    
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
      ...(resourcesWithoutSri && { 
        sri: {
          checked: true,
          resourcesWithoutSri
        }
      }),
      ...(dependencyResults && {
        dependencies: {
          checked: true,
          tree: dependencyResults
        }
      })
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
        console.log('domain,resource_url,resource_type,is_external,screenshot_path,has_sri,dependency_level,parent_resource');
        handleStdoutOutput.headerPrinted = true;
      }
      
      // Print each resource as a CSV row
      if (resources && resources.length > 0) {
        resources.forEach(res => {
          // Check if this resource is in the SRI list
          let hasSri = "N/A";
          if (result.sri) {
            const isScript = res.type === 'script';
            const sriList = isScript ? result.sri.resourcesWithoutSri.scripts : result.sri.resourcesWithoutSri.stylesheets;
            const foundInSriList = sriList.some(item => item.src === res.url);
            
            // Only mark as missing SRI if it's a script or stylesheet
            if ((isScript || res.type === 'stylesheet') && foundInSriList) {
              hasSri = "0"; // No SRI
            } else if (isScript || res.type === 'stylesheet') {
              hasSri = "1"; // Has SRI
            }
          }
          
          // Determine dependency level
          let dependencyLevel = "firstParty";
          let parentResource = "";
          
          if (result.dependencies) {
            const tree = result.dependencies.tree;
            
            // Check if it's a first-party resource
            const isFirstParty = tree.firstParty.some(r => r.url === res.url);
            
            if (!isFirstParty) {
              // Check if it's in any third-party domain
              let foundThirdParty = false;
              for (const thirdPartyDomain in tree.thirdParty) {
                if (tree.thirdParty[thirdPartyDomain].some(r => r.url === res.url)) {
                  dependencyLevel = "thirdParty";
                  foundThirdParty = true;
                  break;
                }
              }
              
              // If not found in third-party, check fourth-party
              if (!foundThirdParty) {
                for (const thirdPartyDomain in tree.fourthParty) {
                  for (const fourthPartyDomain in tree.fourthParty[thirdPartyDomain]) {
                    const matchingResource = tree.fourthParty[thirdPartyDomain][fourthPartyDomain]
                      .find(r => r.url === res.url);
                    
                    if (matchingResource) {
                      dependencyLevel = "fourthParty";
                      parentResource = matchingResource.possibleParent || "";
                      break;
                    }
                  }
                }
              }
            }
          }
          
          console.log(`"${domain}","${res.url}","${res.type}",${res.isExternal ? '1' : '0'},"${result.screenshotPath || ''}","${hasSri}","${dependencyLevel}","${parentResource}"`);
        });
        
        // Add additional resources that might only be in the dependency tree
        if (result.dependencies) {
          const tree = result.dependencies.tree;
          const reportedUrls = new Set(resources.map(r => r.url));
          
          // Add all resources from the dependency tree that weren't already reported
          
          // First-party resources
          tree.firstParty.forEach(resource => {
            if (!reportedUrls.has(resource.url)) {
              console.log(`"${domain}","${resource.url}","${resource.resourceType}",0,"${result.screenshotPath || ''}","N/A","firstParty",""`);
            }
          });
          
          // Third-party resources
          for (const thirdPartyDomain in tree.thirdParty) {
            tree.thirdParty[thirdPartyDomain].forEach(resource => {
              if (!reportedUrls.has(resource.url)) {
                console.log(`"${domain}","${resource.url}","${resource.resourceType}",1,"${result.screenshotPath || ''}","N/A","thirdParty",""`);
              }
            });
          }
          
          // Fourth-party resources
          for (const thirdPartyDomain in tree.fourthParty) {
            for (const fourthPartyDomain in tree.fourthParty[thirdPartyDomain]) {
              tree.fourthParty[thirdPartyDomain][fourthPartyDomain].forEach(resource => {
                if (!reportedUrls.has(resource.url)) {
                  console.log(`"${domain}","${resource.url}","${resource.resourceType}",1,"${result.screenshotPath || ''}","N/A","fourthParty","${resource.possibleParent}"`);
                }
              });
            }
          }
        }
        
        // Also add SRI-missing resources that might not be in any list yet
        if (result.sri) {
          const allSriMissing = [
            ...result.sri.resourcesWithoutSri.scripts,
            ...result.sri.resourcesWithoutSri.stylesheets
          ];
          
          // Filter for resources that weren't already reported
          const reportedUrls = new Set(resources.map(r => r.url));
          const missingOnlySri = allSriMissing.filter(item => !reportedUrls.has(item.src));
          
          missingOnlySri.forEach(item => {
            console.log(`"${domain}","${item.src}","${item.element}",1,"${result.screenshotPath || ''}","0","unknown",""`);
          });
        }
      } else {
        console.log(`"${domain}","no resources found","none",0,"${result.screenshotPath || ''}","N/A","none",""`);
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
      
      // Print SRI information if available
      if (result.sri) {
        const scriptCount = result.sri.resourcesWithoutSri.scripts.length;
        const stylesheetCount = result.sri.resourcesWithoutSri.stylesheets.length;
        const totalMissing = scriptCount + stylesheetCount;
        
        console.log(`\nSubresource Integrity (SRI) Check:`);
        console.log(`- Resources missing integrity attribute: ${totalMissing}`);
        console.log(`  - Scripts: ${scriptCount}`);
        console.log(`  - Stylesheets: ${stylesheetCount}`);
        
        if (totalMissing > 0) {
          console.log(`\nResources without SRI:`);
          result.sri.resourcesWithoutSri.scripts.forEach(script => {
            console.log(`  - [script] ${script.src}`);
          });
          result.sri.resourcesWithoutSri.stylesheets.forEach(stylesheet => {
            console.log(`  - [stylesheet] ${stylesheet.src}`);
          });
        }
      }

      // Print dependency information
      if (result.dependencies) {
        const tree = result.dependencies.tree;
        const thirdPartyDomains = Object.keys(tree.thirdParty);
        const fourthPartyCount = Object.values(tree.fourthParty)
          .reduce((total, domains) => total + Object.keys(domains).length, 0);
        
        console.log(`\nResource Dependency Analysis:`);
        console.log(`- First-party resources: ${tree.firstParty.length}`);
        console.log(`- Third-party domains: ${thirdPartyDomains.length}`);
        console.log(`- Fourth-party domains: ${fourthPartyCount}`);
        
        if (thirdPartyDomains.length > 0) {
          console.log(`\nDependency Tree:`);
          
          // Print first party domain
          console.log(`└── First Party (${domain})`);
          if (tree.firstParty.length > 0) {
            tree.firstParty.slice(0, 5).forEach(resource => {
              console.log(`    ├── ${resource.resourceType}: ${resource.url}`);
            });
            if (tree.firstParty.length > 5) {
              console.log(`    └── ... ${tree.firstParty.length - 5} more resources`);
            }
          }
          
          // Print third party domains
          for (const [idx, thirdPartyDomain] of thirdPartyDomains.entries()) {
            const isLast = idx === thirdPartyDomains.length - 1;
            const thirdPartyResources = tree.thirdParty[thirdPartyDomain];
            
            console.log(`\n${isLast ? '└' : '├'}── Third Party: ${thirdPartyDomain} (${thirdPartyResources.length} resources)`);
            
            // Show a few sample resources from this third party
            thirdPartyResources.slice(0, 3).forEach(resource => {
              console.log(`    ├── ${resource.resourceType}: ${resource.url.substring(0, 100)}${resource.url.length > 100 ? '...' : ''}`);
            });
            
            if (thirdPartyResources.length > 3) {
              console.log(`    └── ... ${thirdPartyResources.length - 3} more resources`);
            }
            
            // Check if this third party has fourth party dependencies
            const fourthParties = tree.fourthParty[thirdPartyDomain];
            if (fourthParties && Object.keys(fourthParties).length > 0) {
              console.log(`    └── Fourth Party Dependencies:`);
              
              Object.entries(fourthParties).forEach(([fourthPartyDomain, resources], fIdx, fArr) => {
                const fIsLast = fIdx === fArr.length - 1;
                console.log(`        ${fIsLast ? '└' : '├'}── ${fourthPartyDomain} (${resources.length} resources)`);
                
                resources.slice(0, 2).forEach((resource, rIdx, rArr) => {
                  const rIsLast = rIdx === rArr.length - 1 && resources.length <= 2;
                  console.log(`            ${rIsLast ? '└' : '├'}── ${resource.resourceType}: ${resource.url.substring(0, 80)}${resource.url.length > 80 ? '...' : ''}`);
                  console.log(`            ${rIsLast ? ' ' : '|'}   └── Likely loaded by: ${resource.possibleParent.substring(0, 60)}${resource.possibleParent.length > 60 ? '...' : ''}`);
                });
                
                if (resources.length > 2) {
                  console.log(`            └── ... ${resources.length - 2} more resources`);
                }
              });
            }
          }
        }
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
  // Process block types, with special handling for "none"
  const blockTypes = !opts.blockTypes || opts.blockTypes === 'none' 
    ? [] 
    : opts.blockTypes.split(',').map(t => t.trim());
  const useStdout = !!opts.stdout;
  const outputFormat = opts.outputFormat || 'json';
  
  // Screenshot options
  const takeScreenshot = !!opts.screenshot;
  const screenshotFormat = (opts.screenshotFormat || 'png').toLowerCase();
  const screenshotPath = opts.screenshotPath || './screenshots';
  const fullPageScreenshot = !!opts.screenshotFullPage;
  
  // Navigation options
  const waitUntil = opts.waitUntil || 'domcontentloaded';
  
  // Security check options
  const checkSri = !!opts.checkSri;
  const trackDependencies = !!opts.trackDependencies;
  
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
    waitUntil,
    checkSri,
    trackDependencies
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
        waitUntil,
        checkSri,
        trackDependencies
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
        waitUntil,
        checkSri,
        trackDependencies
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

