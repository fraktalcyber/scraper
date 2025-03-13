# scraper

see https://blog.fraktal.fi/examining-external-dependencies-in-web-applications-0846894cecdd

## getting started

```
git clone ...
cd scraper 
node install 
npx playwright install-deps
npx playwright install chromium

node scan-domains-playwright.js  --domain https://google.com
```

The Node tool handles lists of thousands of urls pretty well but for larger tasks consider using `batch-run.sh`, which breaks input into chunks and runs the tool with `timeout` (I experienced random hangs when running extremely large scans).

