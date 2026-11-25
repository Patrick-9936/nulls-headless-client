'use strict';
// Spectator launcher — a thin wrapper so the watch mode has its own entry point.
// Everything is done by club-rush.js watch; this only explains the flags once.
const path = require('node:path');
const {spawn} = require('node:child_process');

const argv = process.argv.slice(2);

const HELP = `watch — наблюдатели на игрока

  node tools/watch.js --tag "#TAG"                  камеры, пока цель в бою
  node tools/watch.js --tag "#TAG" --bots 30        сколько наблюдателей
  node tools/watch.js --tag "#TAG" --minutes 10     сколько минут держать
  node tools/watch.js --tag "#TAG" --accounts 1,2,3 конкретные аккаунты
  node tools/watch.js --tag "#TAG" --join-parallel 6  заходов одновременно
  node tools/watch.js --tag "#TAG" --watch-timeout 60000  тишина до переподключения, мс
  node tools/watch.js --tag "#TAG" --direct          без прокси, напрямую

Наблюдатель входит в бой цели как зритель и держит камеру. Если бой кончился
или сервер молчит дольше --watch-timeout, он переподключается сам.`;

if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

const child = spawn(process.execPath, [path.join(__dirname, 'club-rush.js'), 'watch', ...argv], {
  stdio: 'inherit',
});
child.on('error', error => {
  console.error(error.message);
  process.exit(1);
});
child.on('close', code => process.exit(code ?? 0));