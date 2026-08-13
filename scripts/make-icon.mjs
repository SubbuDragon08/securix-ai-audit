#!/usr/bin/env node
/**
 * Render build/icon.png (1024x1024) from an inline SVG using headless Chrome.
 *
 * electron-builder derives .icns and .ico from this single PNG, so one source
 * of truth is enough. Chrome is used because it is already present on any
 * machine that can test the report, and it avoids adding an image dependency to
 * a project whose whole pitch is zero runtime dependencies.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, 'build');
mkdirSync(buildDir, { recursive: true });

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('No Chrome/Chromium found. Install one, or drop your own 1024x1024 build/icon.png.');
  process.exit(1);
}

/* Shield + check: "audited and cleared". Rounded-square ground so it reads
   correctly in a macOS dock and a Windows taskbar without extra masking. */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3d8ae8"/>
      <stop offset="100%" stop-color="#1f5fb0"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="228" fill="url(#g)"/>
  <path d="M512 214 268 316v226c0 152 103 273 244 310 141-37 244-158 244-310V316L512 214Z"
        fill="none" stroke="#ffffff" stroke-width="52" stroke-linejoin="round"/>
  <path d="M406 524l74 74 152-152" fill="none" stroke="#ffffff"
        stroke-width="58" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const htmlPath = join(tmpdir(), `icon-${Date.now()}.html`);
writeFileSync(
  htmlPath,
  `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:1024px;height:1024px;overflow:hidden}</style>
${svg}`,
);

const out = join(buildDir, 'icon.png');
execFileSync(
  chrome,
  [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1024,1024',
    `--screenshot=${out}`,
    `file://${htmlPath}`,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

rmSync(htmlPath, { force: true });
console.log(`icon written -> build/icon.png`);
