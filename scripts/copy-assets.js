const fs = require('fs');
const path = require('path');

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

const srcDir = path.join(__dirname, '../src/data');
const destDir = path.join(__dirname, '../dist/data');

try {
  console.log(`[BUILD] Copying static JSON assets from ${srcDir} to ${destDir}...`);
  copyDirSync(srcDir, destDir);
  console.log('[BUILD] Assets copied successfully.');
} catch (err) {
  console.error('[BUILD] Error copying static assets:', err);
  process.exit(1);
}
