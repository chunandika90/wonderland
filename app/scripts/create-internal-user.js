// Provision a new internal WCCN staff login for this Wonderland instance.
//
// Usage:
//   node scripts/create-internal-user.js <username> <password> "<Full Name>" [admin]
//
// Example:
//   node scripts/create-internal-user.js dinda dinda2026 "Dinda" admin
//
// This is a login, not a client — see scripts/create-org.js for adding a new client
// workspace. Pass "admin" as the last argument to grant access to Agency Overview
// (the cross-client dashboard); omit it for a regular staff account that can still
// switch into and work on any client, just without the cross-client aggregate view.

const fs = require('fs');
const path = require('path');

const [, , username, password, name, adminFlag] = process.argv;

if (!username || !password || !name) {
  console.error('\nUsage: node scripts/create-internal-user.js <username> <password> "<Full Name>" [admin]\n');
  process.exit(1);
}

const USERS_FILE = path.join(__dirname, '..', 'data', 'internal-users.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const users = readJson(USERS_FILE, []);
if (users.find(u => u.username === username)) {
  console.error(`\nA user with username "${username}" already exists.\n`);
  process.exit(1);
}

users.push({ username, password, name, isAdmin: adminFlag === 'admin' });
writeJson(USERS_FILE, users);

console.log(`\nInternal user "${name}" created.`);
console.log(`  Login — username: ${username} / password: ${password}`);
console.log(`  Admin (sees Agency Overview): ${adminFlag === 'admin' ? 'yes' : 'no'}\n`);
