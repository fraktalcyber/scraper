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
async function upsertScan(db, { domain, finalUrl, success, error }) {
  // Do the upsert
  await dbRun(
    db,
    `INSERT INTO scans (domain, finalUrl, success, error)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE
       SET finalUrl = excluded.finalUrl,
           success = excluded.success,
           error = excluded.error,
           scannedAt = CURRENT_TIMESTAMP`,
    [domain, finalUrl || null, success ? 1 : 0, error || null]
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
  const placeholders = resources.map(() => '(?, ?, ?, ?)').join(',');
  const values = resources.flatMap(r => [scanId, r.url, r.type, r.isExternal ? 1 : 0]);
  
  await dbRun(
    db,
    `INSERT INTO resources (scanId, url, resourceType, isExternal) VALUES ${placeholders}`,
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
      const { domain, success, error, finalUrl, resources } = result;

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
          });

          // Handle resources
          if (success) {
            await replaceResources(db, scanId, resources || []);
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
