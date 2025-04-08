import { chromium } from 'playwright';

class BrowserPool {
  constructor(poolSize, logger = console, options = {}) {
    this.poolSize = poolSize;
    this.browser = null;
    this.contexts = [];
    this.contextQueue = [];
    this.contextUsage = new Map();
    this.maxUsagePerContext = 50;
    this.logger = logger;
    this.options = options;
  }

  async init() {
    const blockTypes = this.options.blockTypes || ['image', 'font', 'media'];
    this.logger.info(`Browser pool initializing with block types: ${blockTypes.join(', ')}`);
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process,SpdyAllowInsecureSchemes,Spdy4,NetworkService',
        '--disable-http2',
        '--disable-quic',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-accelerated-2d-canvas',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--no-first-run',
        '--no-zygote',
        '--dns-prefetch-disable',
        '--ignore-certificate-errors',
      ]
    });

    for (let i = 0; i < this.poolSize; i++) {
      await this.createFreshContext(this.options.blockTypes);
    }
  }

  async createFreshContext(blockTypes = ['image', 'font', 'media']) {
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      bypassCSP: true,
      ignoreHTTPSErrors: true
    });

    // Only block specified resource types
    if (blockTypes && blockTypes.length > 0) {
      await context.route('**/*', (route) => {
        const rType = route.request().resourceType();
        if (blockTypes.includes(rType)) {
          route.abort();
        } else {
          route.continue();
        }
      });
    }

    this.contextUsage.set(context, 0);
    this.contexts.push(context);
    return context;
  }

  async acquireContext() {
    let context;
    let attempts = 0;
    const MAX_ATTEMPTS = 3;

    while (attempts < MAX_ATTEMPTS) {
      try {
        if (this.contexts.length > 0) {
          context = this.contexts.pop();
          
          const usageCount = this.contextUsage.get(context) || 0;
          if (usageCount >= this.maxUsagePerContext) {
            await context.close();
            context = await this.createFreshContext(this.options.blockTypes);
          }
          
          await context.pages();
          this.contextUsage.set(context, (this.contextUsage.get(context) || 0) + 1);
          return context;
        }

        return new Promise((resolve) => {
          this.contextQueue.push(resolve);
        });
      } catch (err) {
        attempts++;
        if (context) {
          await context.close().catch(() => {});
        }
        context = await this.createFreshContext(this.options.blockTypes);
        if (attempts >= MAX_ATTEMPTS) throw err;
      }
    }
    throw new Error('Failed to acquire valid browser context');
  }

  async releaseContext(context) {
    try {
      const pages = await context.pages();
      await Promise.all(pages.map(page => page.close().catch(() => {})));
      await context.clearCookies();
      await context.clearPermissions();
      
      if (this.contextQueue.length > 0) {
        const waiter = this.contextQueue.shift();
        waiter(context);
      } else {
        this.contexts.push(context);
      }
    } catch (err) {
      await context.close().catch(() => {});
      const newContext = await this.createFreshContext(this.options.blockTypes);
      this.contexts.push(newContext);
    }
  }

  async close() {
    if (this.browser) {
      for (const context of this.contexts) {
        await context.close().catch(() => {});
      }
      this.contexts = [];
      this.contextUsage.clear();
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

export default BrowserPool;
