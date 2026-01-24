#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

// Load environment
require('dotenv').config();

const child = spawn('node', [
  path.join(__dirname, 'node_modules/@google/adk-devtools/dist/cli/cli.cjs'),
  'web',
  'agents',
  '-h', 'localhost',
  '-p', '8000'
], {
  cwd: __dirname,
  stdio: 'inherit',
  env: process.env
});

child.on('error', (err) => {
  console.error('Failed to start server:', err);
});

// Keep process alive
process.on('SIGINT', () => {
  child.kill('SIGINT');
  process.exit();
});

