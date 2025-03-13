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
 * Replace external scripts for a scan.
 */
async function replaceExternalScripts(db, scanId, scriptUrls) {
  // First delete existing scripts
  await dbRun(db, 'DELETE FROM externalScripts WHERE scanId = ?', [scanId]);
  
  // If no new scripts, we're done
  if (!scriptUrls || scriptUrls.length === 0) return;
  
  // Insert new scripts
  const placeholders = scriptUrls.map(() => '(?, ?)').join(',');
  const values = scriptUrls.flatMap(url => [scanId, url]);
  
  await dbRun(
    db,
    `INSERT INTO externalScripts (scanId, scriptUrl) VALUES ${placeholders}`,
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
      const { domain, success, error, finalUrl, externalScripts } = result;

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

          // Handle scripts
          if (success) {
            await replaceExternalScripts(db, scanId, externalScripts || []);
          } else {
            await dbRun(db, 'DELETE FROM externalScripts WHERE scanId = ?', [scanId]);
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
