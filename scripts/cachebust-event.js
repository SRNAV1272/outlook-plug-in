'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const buildDir = process.env.BUILD_PATH || 'build';
const eventFile = path.resolve(buildDir, 'event.html');
const jsFile = path.resolve(buildDir, 'static/js/event-handler.js');

if (!fs.existsSync(eventFile)) {
  console.log('No event.html found, skipping.');
  process.exit(0);
}

const hash = fs.existsSync(jsFile)
  ? crypto.createHash('md5').update(fs.readFileSync(jsFile)).digest('hex').slice(0, 8)
  : Date.now().toString(36);

let html = fs.readFileSync(eventFile, 'utf8');
html = html.replace('BUILD_HASH', hash);

fs.writeFileSync(eventFile, html, 'utf8');
console.log(`Cache-busted event.html with hash: ${hash}`);