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
    log("Logged in.");

    // --- 2. Pick a profile (Netflix-style picker) ---
    // NOTE: placeholder selector. Inspect the real profile picker page,
    // find the element wrapping each profile tile, and update this.
    // If there's only ever one profile, this click may not be needed at
    // all — but it's safer to try clicking the first/only one.
    log("Selecting profile...");
    try {
      await page.click('.profile-tile, [data-testid="profile-tile"], .profile-card', {
        timeout: 10000,
      });
      await page.waitForTimeout(1500);
    } catch (err) {
      log("No profile picker appeared (or selector needs updating) — continuing.");
    }

    // --- 3. Enter PIN (one digit per box) ---
    // NOTE: placeholder selector. Inspect the real PIN screen — find the
    // input boxes for each digit. They're often a row of single-character
    // inputs. Update the selector below to match (e.g. '.pin-input',
    // 'input[data-pin-digit]', etc.)
    log("Entering PIN...");
    try {
      const pinDigits = TFS24_PIN.split("");
      const pinInputs = await page.$$('.pin-input, [data-testid="pin-digit"], input[maxlength="1"]');

      if (pinInputs.length >= pinDigits.length) {
        for (let i = 0; i < pinDigits.length; i++) {
          await pinInputs[i].fill(pinDigits[i]);
        }
        await page.waitForTimeout(1500);
        log("PIN entered.");
      } else {
        log(
          `Expected ${pinDigits.length} PIN input boxes but found ${pinInputs.length} — selector likely needs updating.`
        );
      }
    } catch (err) {
      log("PIN entry failed (selector likely needs updating):", err.message);
    }

    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});

    // --- 4. Go to the music page ---
    log("Navigating to music page...");
    await page.goto(MUSIC_URL, { waitUntil: "networkidle", timeout: 25000 });

    // Give any client-side rendering a moment to finish populating the list.
    await page.waitForTimeout(3000);

    // --- 5. Extract song titles ---
    // NOTE: this selector is a placeholder. Inspect the real page,
    // find the element that wraps each song's title, and update this.
    // Common patterns: '.song-title', '[data-testid="song-title"]', 'li.track h3'
    const songs = await page.$$eval(
      '.song-title, [data-testid="song-title"], .track-title',
      (els) => els.map((el) => el.textContent.trim()).filter(Boolean)
    );

    log(`Found ${songs.length} songs on page.`);

    if (songs.length === 0) {
      log("No songs found — selector probably needs updating. See comments in this file.");
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