import { createPageHelper } from "./auth";

async function main() {
  const helper = await createPageHelper();
  const page = helper.page;

  try {
    // Navigate to dashboard
    await helper.goto("/dashboard");

    // Wait for actions to resolve
    await page.waitForTimeout(10000);

    // Print console logs to see errors
    helper.printConsoleLogs();

    // Check what's on the page
    const bodyText = await page.locator("body").innerText();
    console.log("\n--- Page text (first 2000 chars) ---");
    console.log(bodyText.slice(0, 2000));

    // Take screenshot
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: "tmp/dashboard-debug.png",
    });

    // Full page
    await page.screenshot({
      path: "tmp/dashboard-full.png",
      fullPage: true,
    });

    console.log("\nScreenshots saved to tmp/");
  } catch (e) {
    console.error("Error:", e);
    await page.screenshot({ path: "tmp/error.png" });
  } finally {
    await helper.close();
  }
}

main();
