#!/usr/bin/env node
require('./lib/CLI').main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
