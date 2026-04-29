#!/usr/bin/env node
"use strict";

const { runCli } = require("../src/cli");

(async () => {
  try {
    const exitCode = await runCli(process.argv.slice(2));
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  }
})();
