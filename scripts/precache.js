// Aktualisiert die Precache-Liste und Version in sw.js. Aufruf: node scripts/precache.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const include = ['index.html', 'manifest.webmanifest', 'css', 'js', 'vendor', 'icons'];
const files = [];
function walk(rel) {
  const abs = path.join(root, rel);
  if (fs.statSync(abs).isDirectory()) {
    for (const f of fs.readdirSync(abs).sort()) if (!f.startsWith('.')) walk(path.posix.join(rel, f));
  } else if (!/(\.map|LICENSE|\.md)$/.test(rel)) files.push(rel);
}
include.forEach(walk);

const hash = crypto.createHash('sha256');
for (const f of files) hash.update(f).update(fs.readFileSync(path.join(root, f)));
const version = hash.digest('hex').slice(0, 10);

const swPath = path.join(root, 'sw.js');
let sw = fs.readFileSync(swPath, 'utf8');
sw = sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
sw = sw.replace(/const ASSETS = \[[\s\S]*?\];/, `const ASSETS = [\n  './',\n${files.map(f => `  '${f}'`).join(',\n')}\n];`);
fs.writeFileSync(swPath, sw);
console.log(`sw.js: ${files.length} Dateien, Version ${version}`);
