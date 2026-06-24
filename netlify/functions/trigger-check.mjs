// netlify/functions/trigger-check.mjs
//
// Runs every 30 minutes (see netlify.toml).
// Scheduled functions are capped at 30 seconds, which is not
// enough time to launch a browser, log in, and read the page —
// so this function's only job is to kick off the background
// function (which gets up to 15 minutes) and return immediately.

export default async (req) => {
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;

  if (!siteUrl) {
    console.error("No site URL available in environment — cannot trigger background function.");
    return new Response("Missing site URL", { status: 500 });
  }

  try {
    // Background functions are invoked by calling their endpoint.
    // We don't await the full result — just fire it and let it run.
    const res = await fetch(`${siteUrl}/.netlify/functions/check-music-background`, {
      method: "POST",
    });

    console.log("Triggered background check, status:", res.status);
  } catch (err) {
    console.error("Failed to trigger background function:", err);
  }

  return new Response("Triggered");
};

export const config = {
  schedule: "*/30 * * * *",
};
