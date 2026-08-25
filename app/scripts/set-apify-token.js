// Attach an Apify API token to an org so it can rescrape its competitor analytics
// (manually via the "Rescrape now" button, and automatically every day at midnight).
//
// Get a token from https://console.apify.com/settings/integrations (free tier works for
// occasional/daily runs of a small actor like this one — check your usage before relying
// on it heavily).
//
// Usage:
//   node scripts/set-apify-token.js <org-slug> <apify-token>
//
// Example:
//   node scripts/set-apify-token.js buranchi apify_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxx

const fs = require('fs');
const path = require('path');

const [, , slug, token] = process.argv;

if (!slug || !token) {
  console.error('\nUsage: node scripts/set-apify-token.js <org-slug> <apify-token>\n');
  process.exit(1);
}

const ORGS_FILE = path.join(__dirname, '..', 'data', 'orgs.json');
const orgs = JSON.parse(fs.readFileSync(ORGS_FILE, 'utf8'));
const org = orgs.find(o => o.slug === slug);

if (!org) {
  console.error(`\nNo org with slug "${slug}" found. Run with no args to see usage, or check data/orgs.json.\n`);
  process.exit(1);
}

org.apifyToken = token;
fs.writeFileSync(ORGS_FILE, JSON.stringify(orgs, null, 2));

console.log(`\nApify token saved for "${org.name}". Restart the server, then use "Rescrape now" on the Competitor Dashboard, or wait for the midnight auto-rescrape.\n`);
