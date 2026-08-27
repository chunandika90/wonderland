// Provision a new client workspace on this Wonderland instance.
//
// Usage:
//   node scripts/create-org.js <slug> "<Client Name>"
//
// Example:
//   node scripts/create-org.js sakara "Sakara Collectives"
//
// This creates data/orgs/<slug>/posts.json (empty) and data/orgs/<slug>/config/*.md
// (blank templates) and registers the client in data/orgs.json. Clients aren't logins —
// see scripts/create-internal-user.js for that — they're workspaces any signed-in WCCN
// staffer can switch into from inside the app. Each client's content plans and brand
// config are fully isolated from every other client on this instance.

const fs = require('fs');
const path = require('path');

const [, , slug, name] = process.argv;

if (!slug || !name) {
  console.error('\nUsage: node scripts/create-org.js <slug> "<Client Name>"\n');
  process.exit(1);
}
if (!/^[a-z0-9-]+$/.test(slug)) {
  console.error('\nslug must be lowercase letters, numbers, and hyphens only (e.g. "sakara-collectives")\n');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const ORGS_FILE = path.join(DATA_DIR, 'orgs.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const orgs = readJson(ORGS_FILE, []);
if (orgs.find(o => o.slug === slug)) {
  console.error(`\nA client with slug "${slug}" already exists.\n`);
  process.exit(1);
}

const org = {
  slug,
  name,
  useSharedConfig: false,
  createdAt: new Date(0).toISOString()
};
orgs.push(org);
writeJson(ORGS_FILE, orgs);

const orgDir = path.join(DATA_DIR, 'orgs', slug);
writeJson(path.join(orgDir, 'posts.json'), []);

const configDir = path.join(orgDir, 'config');
fs.mkdirSync(configDir, { recursive: true });

const templates = {
  'brand-context.md': `# Brand Context — ${name}\n\n## Business Overview\n\n(Describe the business: what it sells, where it operates, what makes it distinct.)\n\n## Positioning\n\n(What's the core differentiator? What narrative should content lean into?)\n\n## Current Priorities (This Quarter)\n\n1. \n2. \n3. \n\n## Rules for Handling Marketing Tasks\n\n1. \n2. \n3. \n`,
  'brand-voice.md': `# Brand Voice — ${name}\n\n## Tone in One Line\n\n(One sentence describing the voice.)\n\n## Core Tone Attributes\n\n- \n- \n\n## Vocabulary\n\n**Lean toward:**\n- \n\n**Avoid:**\n- \n\n## Voice Guardrails\n\nNever sound: \n`,
  'ideal-customer-profile.md': `# Ideal Customer Profile — ${name}\n\n## Primary Persona\n\n**Demographics**\n- \n\n**Buying Triggers**\n- \n\n**Objections / Hesitations**\n- \n`,
  'compass-assistant.md': `# ${name} — Assistant Instructions\n\nPaste this into a Claude Project's custom instructions to turn Claude into ${name}'s content planning assistant.\n\n## 1. Role Definition\n\nYou are **${name}'s** content planning assistant — fill in brand foundations, voice, design system, and output contract here, following the same shape as Buranchi's instructions (see the Buranchi Compass folder for a full worked example).\n`,
  'brand-visual-identity.md': `# Brand Visual Identity — ${name}\n\n## Logo\n\n(Usage rules, clear space, what not to do. Asset file paths if self-hosted.)\n\n## Color\n\n| Role | Hex | Use |\n|---|---|---|\n| | | |\n\n## Typography\n\n(Typeface name(s), weights used, where to get the font files.)\n`
};
Object.entries(templates).forEach(([file, content]) => {
  fs.writeFileSync(path.join(configDir, file), content, 'utf8');
});

console.log(`\nClient "${name}" created.`);
console.log(`  Config templates written to: ${configDir}`);
console.log(`  Fill those in (via the app's Master Config drawer, or by hand) before generating real plans.`);
console.log(`  Any signed-in WCCN staffer can now switch into "${name}" from the client picker.\n`);
