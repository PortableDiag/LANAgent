#!/bin/bash
PASS="$PRODUCTION_PASS"
ssh_cmd() { sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no $PRODUCTION_USER@$PRODUCTION_SERVER "$1" 2>/dev/null; }

# --- CURRENT OP: Deploy all stealth browser changes and test on Etherscan ---

echo "=== Deploying stealth browser changes ==="
cd /media/veracrypt1/NodeJS/LANAgent
./scripts/deployment/deploy-files.sh \
  src/utils/stealthBrowser.js \
  src/services/accountRegistrationService.js \
  src/services/webScraper.js \
  src/services/crypto/nanoButtonFaucet.js \
  src/api/plugins/scraper.js \
  src/interfaces/web/webInterface.js \
  2>&1 | grep -E '✅|✓|error|FAIL|Files to deploy'

echo ""
echo "=== Wait for startup ==="
for i in $(seq 1 20); do
    RESP=$(curl -s -o /dev/null -w "%{http_code}" "http://$PRODUCTION_SERVER/api/auth/login" -X POST -H 'Content-Type: application/json' -d '{"password": "lanagent"}' 2>/dev/null)
    if [ "$RESP" = "200" ]; then
        echo "Server ready after ~${i}0 seconds"
        break
    fi
    sleep 10
done

echo ""
echo "=== Testing stealth Puppeteer on Etherscan Turnstile ==="
ssh_cmd 'cat > $PRODUCTION_PATH/test-stealth.mjs << '"'"'SCRIPT'"'"'
import { launchBrowser } from "./src/utils/stealthBrowser.js";

(async () => {
  console.log("1. Launching stealth browser...");
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  console.log("2. Navigating to etherscan.io/register...");
  await page.goto("https://etherscan.io/register", { waitUntil: "networkidle2", timeout: 30000 });
  console.log("   Title:", await page.title());

  console.log("3. Waiting for Turnstile to resolve...");
  let resolved = false;
  for (let i = 0; i < 20; i++) {
    const token = await page.evaluate(() => {
      const el = document.querySelector("input[name=cf-turnstile-response]");
      return el ? el.value : "";
    });
    if (token && token.length > 10) {
      console.log("   TURNSTILE RESOLVED! Token length:", token.length);
      resolved = true;
      break;
    }
    // Also check for turnstile iframe status
    const status = await page.evaluate(() => {
      const iframe = document.querySelector("iframe[src*=turnstile]");
      return iframe ? "iframe present" : "no iframe";
    });
    console.log("   Waiting... (" + (i+1) + "/20) " + status);
    await new Promise(r => setTimeout(r, 2000));
  }

  if (resolved) {
    console.log("\n   SUCCESS: Stealth plugin bypassed Turnstile!");
  } else {
    console.log("\n   FAILED: Turnstile still blocked stealth browser");
    await page.screenshot({ path: "/tmp/stealth-turnstile-fail.png", fullPage: true });
    console.log("   Screenshot: /tmp/stealth-turnstile-fail.png");
  }

  await browser.close();
})().catch(e => { console.error("FATAL:", e.message, e.stack?.split("\\n")[1]); process.exit(1); });
SCRIPT'

ssh_cmd "cd $PRODUCTION_PATH && node test-stealth.mjs 2>&1 && rm -f test-stealth.mjs"
