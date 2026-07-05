// build.js — assembles src/ files into public/retrochung.html and public/library.html
const fs   = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, 'src');

// Each entry: { src: 'src/shell-file', out: 'public/output-file' }
const TARGETS = [
  { src: 'template.html',      out: path.join(__dirname, 'public', 'retrochung.html') },
  { src: 'library-shell.html', out: path.join(__dirname, 'public', 'library.html')    },
];

function buildOne(srcFile, outputPath) {
  const start        = Date.now();
  const templatePath = path.join(SRC_DIR, srcFile);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`[build] src/${srcFile} not found — cannot build`);
  }

  let html = fs.readFileSync(templatePath, 'utf-8');

  // Replace all /* INJECT:filename */ placeholders
  const injectRe = /\/\*\s*INJECT:([\w.\-]+)\s*\*\//g;
  const missing  = [];
  html = html.replace(injectRe, (match, filename) => {
    const filePath = path.join(SRC_DIR, filename);
    if (!fs.existsSync(filePath)) {
      missing.push(filename);
      return `/* MISSING: ${filename} */`;
    }
    return fs.readFileSync(filePath, 'utf-8');
  });

  if (missing.length > 0) {
    console.warn(`[build] WARNING: missing src files: ${missing.join(', ')}`);
  }

  // Verify no unresolved placeholders remain
  const unresolved = html.match(/\/\*\s*INJECT:/g);
  if (unresolved) {
    console.warn(`[build] WARNING: ${unresolved.length} unresolved INJECT placeholder(s) in output`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf-8');

  const lines = html.split('\n').length;
  const ms    = Date.now() - start;
  console.log(`[build] Built ${path.relative(__dirname, outputPath)} — ${lines} lines in ${ms}ms`);
}

function build() {
  TARGETS.forEach(({ src, out }) => buildOne(src, out));
}

// Allow running directly: node build.js
// Or required by server.js for auto-build on startup
try {
  build();
} catch (err) {
  console.error(err.message);
  // If run directly, exit with error; if required by server, let server handle it
  if (require.main === module) process.exit(1);
  else throw err;
}
