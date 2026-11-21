#!/usr/bin/env node
require('./lib/CLI')
  .main()
  .catch((error) => {
    console.error(error.message);
    // lib/CLI уже выставил код (2 для ошибок аргументов); не перетираем его.
    if (!process.exitCode) process.exitCode = error.exitCode || (error.kind === 'input' ? 2 : 1);
  });
