import pino from 'pino';

const defaultLogger = pino({
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
});

////////////////////////////////////////////////////////////////////////////////
// Database Helpers
////////////////////////////////////////////////////////////////////////////////

/**
 * Promisified db.run
 */
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

/**
 * Promisified db.get
 */
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

/**
 * Upsert a scan record and return its ID.
 */
async function upsertScan(db, { domain, finalUrl, success, error, screenshotPath }) {
  // Do the upsert
  await dbRun(
    db,
    `INSERT INTO scans (domain, finalUrl, success, error, screenshotPath)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE
       SET finalUrl = excluded.finalUrl,
           success = excluded.success,
           error = excluded.error,
           screenshotPath = excluded.screenshotPath,
           scannedAt = CURRENT_TIMESTAMP`,
    [domain, finalUrl || null, success ? 1 : 0, error || null, screenshotPath || null]
  );

  // Get the scan ID
  const row = await dbGet(
    db,
    'SELECT id FROM scans WHERE domain = ?',
    [domain]
  );
  return row.id;
}

/**
 * Replace resources for a scan.
 */
async function replaceResources(db, scanId, resources) {
  // First delete existing resources
  await dbRun(db, 'DELETE FROM resources WHERE scanId = ?', [scanId]);
  
  // If no new resources, we're done
  if (!resources || resources.length === 0) return;
  
  // Insert new resources
  const placeholders = resources.map(() => '(?, ?, ?, ?, ?)').join(',');
  const values = resources.flatMap(r => [
    scanId, 
    r.url, 
    r.type, 
    r.isExternal ? 1 : 0,
    r.hasSri !== undefined ? r.hasSri : null
  ]);
  
  await dbRun(
    db,
    `INSERT INTO resources (scanId, url, resourceType, isExternal, hasSri) VALUES ${placeholders}`,
    values
  );
}

/**
 * Create database handlers with optional custom logger
 */
function createDbHandlers(customLogger = defaultLogger) {
  return {
    /**
     * Main DB write handler
     */
    async handleDbWrite(db, result, processedDomains, writeCheckpoint) {
      const { domain, success, error, finalUrl, screenshotPath, resources, sri } = result;

      try {
        // Start transaction
        await dbRun(db, 'BEGIN IMMEDIATE TRANSACTION');

        try {
          // Do the scan upsert
          const scanId = await upsertScan(db, {
            domain,
            finalUrl: finalUrl || null,
            success,
            error,
            screenshotPath,
          });

          // Handle resources
          if (success) {
            // If SRI check was performed, mark resources accordingly
            let resourcesToSave = resources || [];
            
            if (sri && sri.checked) {
              // Create sets of URLs without SRI
              const scriptsWithoutSri = new Set(sri.resourcesWithoutSri.scripts.map(s => s.src));
              const stylesheetsWithoutSri = new Set(sri.resourcesWithoutSri.stylesheets.map(s => s.src));
              
              // Add hasSri field to resources
              resourcesToSave = resourcesToSave.map(resource => {
                const isScriptOrStylesheet = resource.type === 'script' || resource.type === 'stylesheet';
                if (isScriptOrStylesheet) {
                  const inScriptList = scriptsWithoutSri.has(resource.url);
                  const inStylesheetList = stylesheetsWithoutSri.has(resource.url);
                  
                  return {
                    ...resource,
                    hasSri: (inScriptList || inStylesheetList) ? 0 : 1
                  };
                }
                return resource;
              });
              
              // Add resources that were found in SRI check but not in main resource list
              const allCapturedUrls = new Set(resources.map(r => r.url));
              
              // Add missing script resources
              sri.resourcesWithoutSri.scripts.forEach(script => {
                if (!allCapturedUrls.has(script.src)) {
                  resourcesToSave.push({
                    url: script.src,
                    type: 'script',
                    isExternal: true, // Assuming external since these are missing SRI
                    hasSri: 0
                  });
                }
              });
              
              // Add missing stylesheet resources
              sri.resourcesWithoutSri.stylesheets.forEach(stylesheet => {
                if (!allCapturedUrls.has(stylesheet.src)) {
                  resourcesToSave.push({
                    url: stylesheet.src,
                    type: 'stylesheet',
                    isExternal: true, // Assuming external since these are missing SRI
                    hasSri: 0
                  });
                }
              });
            }
            
            await replaceResources(db, scanId, resourcesToSave);
          } else {
            await dbRun(db, 'DELETE FROM resources WHERE scanId = ?', [scanId]);
          }

          // Commit transaction
          await dbRun(db, 'COMMIT');

          // Update checkpoint (outside transaction)
          processedDomains.add(domain);
          if (processedDomains.size % 10 === 0) {
            writeCheckpoint(processedDomains);
            customLogger.info(`Checkpoint updated. Processed: ${processedDomains.size}`);
          }
        } catch (err) {
          // Rollback on error
          await dbRun(db, 'ROLLBACK');
          throw err;
        }
      } catch (dbErr) {
        customLogger.error({ 
          msg: 'DB write error', 
          domain, 
          err: dbErr.message,
          stack: dbErr.stack
        });
        throw dbErr;  // Re-throw to trigger retry logic if needed
      }
    }
  };
}

export { createDbHandlers };
