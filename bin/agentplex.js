#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");

const child = spawn("npx", ["electron-forge", "start"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
