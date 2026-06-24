// netlify/functions/check-music-background.mjs
//
// Does the real work:
//   1. Launches headless Chromium
//   2. Logs into 24six.app with credentials from environment variables
//   3. Loads https://24six.app/app/music
//   4. Extracts the current list of song titles
//   5. Compares to the last saved list (stored in Netlify Blobs)
//   6. If there are new songs, emails an alert via Resend
//   7. Saves the current list as the new "last seen" baseline
//
// Required environment variables (set these in Netlify's UI under
// Site configuration > Environment variables — never commit them):
//   TFS24_EMAIL          your 24six.app login email
//   TFS24_PASSWORD       your 24six.app login password
//   TFS24_PIN            your 24six.app profile PIN (numeric, entered
//                        one digit per box after picking a profile)
//   RESEND_API_KEY       API key from resend.com
//   ALERT_EMAIL_TO       where to send the "new songs" alert
//   ALERT_EMAIL_FROM     a "from" address verified in Resend
//                        (e.g. alerts@yourdomain.com)
//
// Login flow handled below: email/password -> pick profile -> enter
// PIN (one digit per box, Netflix-style) -> music page.

import chromium from "@sparticuz/chromium";
import { chromium as playwright } from "playwright-core";
import { getStore } from "@netlify/blobs";
import { Resend } from "resend";

const MUSIC_URL = "https://24six.app/app/music";
const LOGIN_URL = "https://24six.app/login"; // adjust if the real login URL differs
const STORE_NAME = "music-monitor";
const STORE_KEY = "last-seen-songs";

export default async (req) => {
  const log = (...args) => console.log("[check-music]", ...args);

  const {
    TFS24_EMAIL,
    TFS24_PASSWORD,
    TFS24_PIN,
    RESEND_API_KEY,
    ALERT_EMAIL_TO,
    ALERT_EMAIL_FROM,
  } = process.env;

  if (!TFS24_EMAIL || !TFS24_PASSWORD) {
    log("Missing TFS24_EMAIL or TFS24_PASSWORD env vars. Aborting.");
    return new Response("Missing login credentials", { status: 500 });
  }
  if (!TFS24_PIN) {
    log("Missing TFS24_PIN env var. Aborting.");
    return new Response("Missing profile PIN", { status: 500 });
  }
  if (!RESEND_API_KEY || !ALERT_EMAIL_TO || !ALERT_EMAIL_FROM) {
    log("Missing email config env vars. Aborting.");
    return new Response("Missing email config", { status: 500 });
  }

  let browser;
  try {
    log("Launching headless Chromium...");
    browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();

    // --- 1. Log in ---
    log("Going to login page...");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 25000 });

    // NOTE: these selectors are placeholders. Once you have the real
    // login page open, right-click the email/password fields and
    // "Inspect" to find their actual name/id, then update the two
    // lines below to match.
    await page.fill('input[type="email"], input[name="email"]', TFS24_EMAIL);
    await page.fill('input[type="password"], input[name="password"]', TFS24_PASSWORD);
    await page.click('button[type="submit"]');

    await page.waitForLoadState("networkidle", { timeout: 25000 });
    log("Logged in. Current URL:", page.url());

    // --- 2. Pick a profile (Netflix-style picker) ---
    // Confirmed selector from inspecting the real 24six profile screen:
    // <div class="profile-select-avatar"><div class="avatar-holder">...
    // Give the page extra time to render the profile tiles before trying.
    log("Selecting profile...");
    try {
      await page.waitForSelector('.avatar-holder', { timeout: 15000 });
      await page.click('.avatar-holder');
      await page.waitForTimeout(2000);
      log("Profile clicked. Current URL:", page.url());
    } catch (err) {
      log("No profile picker appeared (or selector needs updating) — continuing. Current URL:", page.url());
    }

    // --- 3. Enter PIN (one digit per box) ---
    // Confirmed selector from inspecting the real 24six PIN screen:
    // <input type="text" maxlength="1" data-index="0/1/2/3" ...>
    log("Entering PIN...");
    try {
      await page.waitForSelector('input[maxlength="1"][data-index]', { timeout: 15000 });
      const pinDigits = TFS24_PIN.split("");
      const pinInputs = await page.$$('input[maxlength="1"][data-index]');

      if (pinInputs.length >= pinDigits.length) {
        for (let i = 0; i < pinDigits.length; i++) {
          await pinInputs[i].fill(pinDigits[i]);
        }
        await page.waitForTimeout(2000);
        log("PIN entered. Current URL:", page.url());
      } else {
        log(
          `Expected ${pinDigits.length} PIN input boxes but found ${pinInputs.length} — selector likely needs updating.`
        );
      }
    } catch (err) {
      log("PIN entry failed (selector likely needs updating or screen never appeared):", err.message, "Current URL:", page.url());
    }

    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});

    // --- 4. Go to the music page ---
    log("Navigating to music page... Current URL before nav:", page.url());
    await page.goto(MUSIC_URL, { waitUntil: "networkidle", timeout: 25000 });
    log("After navigating to music page, current URL:", page.url());

    // Give any client-side rendering a moment to finish populating the list.
    await page.waitForTimeout(3000);

    // --- 5. Extract titles from "New Singles", "New Albums", and
    //         "Featured New Releases" only (per your request — other
    //         sections like Trending Now are intentionally ignored) ---
    //
    // The page embeds its full content as JSON in a data-page attribute
    // on the #app div, rather than plain text in the DOM. We read that
    // attribute and search through ALL its sections for ones whose
    // headline matches the three we care about, by partial/case-insensitive
    // match — so small wording differences (e.g. "New Singles 2026" or
    // "Featured: New Releases") still match.
    const { songs, debugSectionNames } = await page.evaluate(() => {
      const appDiv = document.querySelector("#app[data-page]");
      if (!appDiv) return { songs: [], debugSectionNames: [] };

      let data;
      try {
        data = JSON.parse(appDiv.getAttribute("data-page"));
      } catch (e) {
        return { songs: [], debugSectionNames: [] };
      }

      const wantedKeywords = ["new single", "new album", "featured new release"];
      const titles = [];
      const debugSectionNames = [];

      // Recursively walk the whole JSON object looking for any section
      // that has a "headline" (or "title" used as a section header) and
      // a "tiles" (or similar) array of items underneath it — this covers
      // sections wherever they live in the structure, without needing to
      // know the exact key path in advance.
      function walk(node) {
        if (!node || typeof node !== "object") return;

        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }

        const headline = (node.headline || node.section_title || "").toString();
        const itemsArray = node.tiles || node.items || node.results;

        if (headline) {
          debugSectionNames.push(headline);
        }

        if (headline && Array.isArray(itemsArray)) {
          const headlineLower = headline.toLowerCase();
          const matches = wantedKeywords.some((kw) => headlineLower.includes(kw));
          if (matches) {
            for (const t of itemsArray) {
              if (t && t.title) titles.push(t.title);
            }
          }
        }

        for (const key in node) {
          if (key === "headline" || key === "section_title") continue;
          walk(node[key]);
        }
      }

      walk(data);

      return { songs: [...new Set(titles)].filter(Boolean), debugSectionNames };
    });

    log(`Found ${songs.length} matching items (New Singles / New Albums / Featured New Releases).`);
    log("All section headlines seen on page (for reference):", JSON.stringify(debugSectionNames));

    if (songs.length === 0) {
      log(
        "No matching items found. Check the section headlines logged above — " +
        "if the real section names don't contain 'new single', 'new album', or " +
        "'featured new release', update the wantedKeywords list in this file to match."
      );
      // Extra diagnostic: capture page title and a snippet of body text so
      // we can tell whether we actually reached the music page or got
      // stuck somewhere earlier (e.g. still on PIN screen, redirected to
      // login, hit an error page, etc.)
      const pageTitle = await page.title().catch(() => "(could not read title)");
      const bodySnippet = await page
        .evaluate(() => document.body.innerText.slice(0, 300))
        .catch(() => "(could not read body text)");
      log("Diagnostic — page title:", pageTitle);
      log("Diagnostic — body text snippet:", bodySnippet);
    }

    // --- 6. Compare to last seen ---
    const store = getStore(STORE_NAME);
    const previousRaw = await store.get(STORE_KEY, { type: "json" });
    const previousSongs = previousRaw?.songs || [];

    const newSongs = songs.filter((s) => !previousSongs.includes(s));

    log(`${newSongs.length} new song(s) since last check.`);

    // --- 7. Email if there's something new (and this isn't the first run) ---
    if (newSongs.length > 0 && previousSongs.length > 0) {
      const resend = new Resend(RESEND_API_KEY);

      await resend.emails.send({
        from: ALERT_EMAIL_FROM,
        to: ALERT_EMAIL_TO,
        subject: `${newSongs.length} new song${newSongs.length > 1 ? "s" : ""} on 24six`,
        text:
          `New songs found on ${MUSIC_URL}:\n\n` +
          newSongs.map((s) => `- ${s}`).join("\n") +
          `\n\nChecked at ${new Date().toISOString()}`,
      });

      log("Alert email sent.");
    } else if (previousSongs.length === 0) {
      log("First run — saving baseline, no email sent.");
    } else {
      log("No new songs — no email sent.");
    }

    // --- 8. Save current list as new baseline ---
    await store.setJSON(STORE_KEY, {
      songs,
      checkedAt: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({ totalSongs: songs.length, newSongs }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    log("Error during check:", err.message);
    return new Response(`Error: ${err.message}`, { status: 500 });
  } finally {
    if (browser) await browser.close();
  }
};