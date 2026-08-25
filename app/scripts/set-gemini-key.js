// Attach a Gemini API key to an org so the in-app "Generate with AI" button can call it directly,
// instead of requiring a chat session with Claude every time.
//
// Get a key from https://aistudio.google.com/apikey (free tier available — check current
// rate limits/quota in AI Studio before relying on this heavily for daily use).
//
// Usage:
//   node scripts/set-gemini-key.js <org-slug> <gemini-api-key>
//
// Example:
//   node scripts/set-gemini-key.js buranchi AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

const fs = require('fs');
const path = require('path');

const [, , slug, key] = process.argv;

if (!slug || !key) {
  console.error('\nUsage: node scripts/set-gemini-key.js <org-slug> <gemini-api-key>\n');
  process.exit(1);
}

const ORGS_FILE = path.join(__dirname, '..', 'data', 'orgs.json');
const orgs = JSON.parse(fs.readFileSync(ORGS_FILE, 'utf8'));
const org = orgs.find(o => o.slug === slug);

if (!org) {
  console.error(`\nNo org with slug "${slug}" found.\n`);
  process.exit(1);
}

org.geminiApiKey = key;
fs.writeFileSync(ORGS_FILE, JSON.stringify(orgs, null, 2));

console.log(`\nGemini key saved for "${org.name}". Restart the server, then use "Generate with AI" on the Generate a plan section.\n`);
