# 24six music monitor

Checks https://24six.app/app/music every 30 minutes. Logs in with your
account, reads the current list of songs, and emails you if anything
new has appeared since the last check. The first run just saves a
baseline — no email is sent until run #2 has something to compare against.

## Before you deploy: 2 things you MUST fix

The login page URL and the song-title selectors in
`netlify/functions/check-music-background.mjs` are placeholders —
I don't have access to your logged-in account, so I can't see the
real HTML. You need to fill these in once:

### 1. Find the real login page and field names
1. Open https://24six.app in a normal browser, click "Log in"
2. Note the actual URL it takes you to → update `LOGIN_URL` at the top
   of `check-music-background.mjs`
3. Right-click the email field → Inspect → note its `name` or `id`
   attribute. Same for the password field and the submit button.
4. Update these three lines in the file:
   ```js
   await page.fill('input[type="email"], input[name="email"]', TFS24_EMAIL);
   await page.fill('input[type="password"], input[name="password"]', TFS24_PASSWORD);
   await page.click('button[type="submit"]');
   ```

### 2. Find the real song title selector
1. Log in normally, go to /app/music
2. Right-click directly on a song title → Inspect
3. Note the class name or attribute on that element
4. Update this line:
   ```js
   const songs = await page.$$eval(
     '.song-title, [data-testid="song-title"], .track-title',
     ...
   ```
   Replace with whatever you found, e.g. `.track-name` or
   `[data-song-title]`.

If you're not comfortable doing this yourself, take a screenshot of
the page's HTML (right-click → Inspect → screenshot the panel) and
send it back — I can write the exact selector for you.

## Setup

### 1. Get a Resend API key (free)
- Sign up at https://resend.com
- Verify a sending domain or use their test domain for now
- Create an API key

### 2. Push this to GitHub, then connect to Netlify
```bash
git init
git add .
git commit -m "24six music monitor"
```
Push to a new GitHub repo, then in Netlify: "Add new site" → "Import
an existing project" → pick the repo.

### 3. Set environment variables in Netlify
Site configuration → Environment variables → add:

| Key | Value |
|---|---|
| `TFS24_EMAIL` | your 24six.app login email |
| `TFS24_PASSWORD` | your 24six.app login password |
| `RESEND_API_KEY` | from resend.com |
| `ALERT_EMAIL_TO` | where you want alerts sent |
| `ALERT_EMAIL_FROM` | a verified sender address, e.g. `alerts@yourdomain.com` |

Netlify Blobs needs no setup — it's automatically available to
functions on your site.

### 4. Deploy
Push to your connected branch — Netlify builds and deploys
automatically. Check the Functions tab to confirm both
`trigger-check` and `check-music-background` show up, with
`trigger-check` marked "Scheduled."

### 5. Test it manually before waiting 30 minutes
Functions tab → `check-music-background` → "Run now" (or trigger it
via the trigger-check function). Check the logs for each step —
"Logged in", "Found N songs on page", etc. This is how you'll catch
selector mistakes.

## Notes
- First run only saves a baseline — you won't get an email until
  the second run finds something new.
- If login starts failing (24six changes their login page), check
  the function logs first — that's almost always a selector that
  needs updating, not a bug in the logic.
- Costs: Netlify free tier covers this easily at 48 checks/day.
  Resend free tier covers up to 3,000 emails/month.
