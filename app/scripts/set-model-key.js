// Attach an API key for a Creative Chat model provider to an org, so the model-picker dropdown
// in Creative Chat can call that provider directly.
//
// Usage:
//   node scripts/set-model-key.js <org-slug> <provider> <api-key>
//
// provider is one of: gemini, claude, gpt, kimi
//
// Where to get a key:
//   gemini  -> https://aistudio.google.com/apikey
//   claude  -> https://console.anthropic.com/settings/keys
//   gpt     -> https://platform.openai.com/api-keys
//   kimi    -> https://platform.moonshot.ai/console/api-keys (Moonshot AI, OpenAI-compatible)
//
// Example:
//   node scripts/set-model-key.js buranchi claude sk-ant-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

const fs = require('fs');
const path = require('path');

const [, , slug, provider, key] = process.argv;
const FIELD_BY_PROVIDER = { gemini: 'geminiApiKey', claude: 'claudeApiKey', gpt: 'openaiApiKey', kimi: 'kimiApiKey' };

if (!slug || !provider || !key || !FIELD_BY_PROVIDER[provider]) {
  console.error('\nUsage: node scripts/set-model-key.js <org-slug> <provider> <api-key>');
  console.error('provider is one of: gemini, claude, gpt, kimi\n');
  process.exit(1);
}

const ORGS_FILE = path.join(__dirname, '..', 'data', 'orgs.json');
const orgs = JSON.parse(fs.readFileSync(ORGS_FILE, 'utf8'));
const org = orgs.find(o => o.slug === slug);

if (!org) {
  console.error(`\nNo org with slug "${slug}" found.\n`);
  process.exit(1);
}

org[FIELD_BY_PROVIDER[provider]] = key;
fs.writeFileSync(ORGS_FILE, JSON.stringify(orgs, null, 2));

console.log(`\n${provider} key saved for "${org.name}". Restart the server, then pick "${provider}" from the model dropdown in Creative Chat.\n`);
