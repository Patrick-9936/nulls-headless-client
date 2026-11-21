const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const watch = require('../tools/watch');
const I18N = require('../lib/i18n');

I18N.setLanguage('ru');

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-watch-'));
const clean = (root) => fs.rmSync(root, { recursive: true, force: true });

function writeStatus(root, patch = {}) {
  const status = {
    pid: 4242,
    updatedAt: '2026-11-21T14:00:00.000Z',
    first: 1,
    requested: 4,
    clubTag: '#TEST',
    states: { online: 2, queued: 1, failed: 1 },
    creationPaused: null,
    metrics: { avgLoginMs: 3200, avgRttMs: 45 },
    bots: [
      { index: 1, tag: '#ABC', name: 'Первый', status: 'online', attempts: 1, error: null },
      { index: 2, tag: '#DEF', name: 'Очень-длинное-имя-бота-для-проверки-обрезки', status: 'online', attempts: 2 },
      { index: 3, status: 'failed', attempts: 5, error: 'Вход/ник не подтверждены за 90 секунд' },
      { index: 4, status: 'queued', attempts: 0 },
    ],
    ...patch,
  };
  fs.writeFileSync(path.join(root, 'fleet-status.json'), JSON.stringify(status, null, 2));
  return status;
}

test('кадр собирается из fleet-status.json и содержит ботов', () => {
  const root = tempRoot();
  try {
    writeStatus(root);
    fs.writeFileSync(path.join(root, 'fleet.log'), 'старт\nподключение ок\nошибка бота 3\n');
    const frame = watch.collectFrame({ root, width: 80, now: Date.parse('2026-11-21T14:00:04.000Z') });
    assert.equal(frame.online, 2);
    assert.equal(frame.total, 4);
    assert.deepEqual(frame.metrics, { loginMs: 3200, rttMs: 45 });
    assert.equal(frame.commandErrors.length, 0);
    assert.deepEqual(frame.log, ['старт', 'подключение ок', 'ошибка бота 3']);
    const text = watch.renderFrame(frame);
    assert.match(text, /Флот Nulls/);
    assert.match(text, /онлайн 2 из 4/);
    assert.match(text, /вход: 3200 мс/);
    assert.match(text, /#ABC/);
    assert.match(text, /Вход\/ник не подтверждены/);
  } finally {
    clean(root);
  }
});

test('без fleet.pid флот честно помечен как незапущенный', () => {
  const root = tempRoot();
  try {
    writeStatus(root);
    const frame = watch.collectFrame({ root, width: 80 });
    assert.equal(frame.running, false);
    assert.equal(frame.statusFile.present, true);
    const text = watch.renderFrame(frame);
    assert.match(text, /флот не запущен/);
    assert.match(text, /последний сохранённый статус/);
  } finally {
    clean(root);
  }
});

test('отсутствие fleet-status.json не ошибка, а понятное сообщение', () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'accounts', 'index.json'), JSON.stringify({ accounts: [{ index: 1 }] }));
    const frame = watch.collectFrame({ root, width: 80 });
    assert.equal(frame.statusFile.present, false);
    assert.equal(frame.total, 0);
    const text = watch.renderFrame(frame);
    assert.match(text, /реестр аккаунтов: 1/);
    assert.match(text, /fleet-status\.json отсутствует/);
    assert.match(text, /fleet\.log пуст или отсутствует/);
  } finally {
    clean(root);
  }
});

test('--once: один кадр и выход, без таймера', async () => {
  const root = tempRoot();
  try {
    writeStatus(root);
    const chunks = [];
    await watch.run({
      root,
      options: { once: true, logLines: 2 },
      flags: {},
      env: { COLUMNS: '80', NO_COLOR: '1' },
      write: (chunk) => chunks.push(chunk),
    });
    const text = chunks.join('');
    assert.match(text, /Флот Nulls/);
    assert.equal(text.includes('\u001b[?25l'), false, 'без TTY курсор не скрывается');
  } finally {
    clean(root);
  }
});

test('--json: один кадр объектом и никакого текста', async () => {
  const root = tempRoot();
  try {
    writeStatus(root);
    const printed = [];
    const chunks = [];
    await watch.run({
      root,
      options: {},
      flags: { json: true },
      env: { COLUMNS: '80' },
      print: (value) => printed.push(value),
      write: (chunk) => chunks.push(chunk),
    });
    assert.equal(chunks.length, 0);
    assert.equal(printed.length, 1);
    assert.equal(printed[0].ok, true);
    const frame = printed[0].result;
    assert.equal(frame.online, 2);
    assert.equal(frame.running, false);
    assert.equal(frame.bots.length, 4);
  } finally {
    clean(root);
  }
});

test('длинные имена и строки обрезаются по ширине терминала', () => {
  const root = tempRoot();
  try {
    writeStatus(root, {
      bots: [{ index: 1, name: 'Имя'.repeat(80), status: 'online', attempts: 1, error: 'E'.repeat(200) }],
    });
    fs.writeFileSync(path.join(root, 'fleet.log'), 'строка '.repeat(100) + '\n');
    const frame = watch.collectFrame({ root, width: 60 });
    const lines = watch.renderFrame(frame).split('\n');
    for (const line of lines) assert.ok(watch.visualWidth(line) <= 60, `строка шире кадра: ${line}`);
    assert.ok(
      lines.some((line) => line.includes('…')),
      'длинные значения должны обрезаться',
    );
  } finally {
    clean(root);
  }
});

test('фильтр --bots first:count ограничивает таблицу', () => {
  const root = tempRoot();
  try {
    writeStatus(root);
    const frame = watch.collectFrame({ root, width: 80, options: { bots: '2:2' } });
    assert.deepEqual(
      frame.bots.map((bot) => bot.index),
      [2, 3],
    );
  } finally {
    clean(root);
  }
});

test('parseArgv: --once/--json не съедают аргументы и не зависят от порядка', () => {
  assert.deepEqual(watch.parseArgv(['--once']).options, { once: true });
  assert.deepEqual(watch.parseArgv(['--once']).flags, { json: false, quiet: false, noColor: false });

  const first = watch.parseArgv(['--once', '--json']);
  assert.equal(first.options.once, true);
  assert.equal(first.flags.json, true);

  const second = watch.parseArgv(['--json', '--once']);
  assert.equal(second.options.once, true);
  assert.equal(second.flags.json, true);

  const values = watch.parseArgv(['--interval', '500', '--log-lines', '3', '--bots', '2:2', '--no-color']);
  assert.equal(values.options.interval, '500');
  assert.equal(values.options.logLines, '3');
  assert.equal(values.options.bots, '2:2');
  assert.equal(values.flags.noColor, true);
});

test('run с --bots 2:2 фильтрует ботов по-настоящему (B1)', async () => {
  const root = tempRoot();
  try {
    writeStatus(root, {
      bots: [
        { index: 1, tag: '#ONE', name: 'BOT-ONE', status: 'online', attempts: 1 },
        { index: 2, tag: '#TWO', name: 'BOT-TWO', status: 'online', attempts: 1 },
        { index: 3, tag: '#THREE', name: 'BOT-THREE', status: 'queued', attempts: 0 },
      ],
    });
    const chunks = [];
    await watch.run({
      root,
      options: { bots: '2:2', once: true, logLines: 0 },
      flags: {},
      env: { COLUMNS: '100', NO_COLOR: '1' },
      write: (chunk) => chunks.push(chunk),
    });
    const text = chunks.join('');
    assert.equal(text.includes('BOT-ONE'), false, 'бот вне диапазона не должен попадать в кадр');
    assert.match(text, /BOT-TWO/);
    assert.match(text, /BOT-THREE/);
    assert.match(text, /онлайн 1 из 2/);
  } finally {
    clean(root);
  }
});

test('--once через parseArgv завершается одним кадром', async () => {
  const root = tempRoot();
  try {
    writeStatus(root);
    const { options, flags } = watch.parseArgv(['--once']);
    const chunks = [];
    await watch.run({
      root,
      options,
      flags,
      env: { COLUMNS: '80', NO_COLOR: '1' },
      write: (chunk) => chunks.push(chunk),
    });
    assert.match(chunks.join(''), /Флот Nulls/);
  } finally {
    clean(root);
  }
});

test('--once --json и --json --once дают ровно один JSON-кадр', async () => {
  const root = tempRoot();
  try {
    writeStatus(root);
    for (const argv of [
      ['--once', '--json'],
      ['--json', '--once'],
    ]) {
      const { options, flags } = watch.parseArgv(argv);
      const printed = [];
      const chunks = [];
      await watch.run({
        root,
        options,
        flags,
        env: { COLUMNS: '80' },
        print: (value) => printed.push(value),
        write: (chunk) => chunks.push(chunk),
      });
      assert.equal(printed.length, 1, `${argv.join(' ')}: один кадр`);
      assert.equal(printed[0].ok, true);
      assert.equal(chunks.length, 0, `${argv.join(' ')}: без текстового кадра`);
    }
  } finally {
    clean(root);
  }
});

test('кэш не перечитывает лог и результаты чаще лимита', () => {
  const root = tempRoot();
  const originalReaddir = fs.readdirSync;
  const originalOpen = fs.openSync;
  let readdirCalls = 0;
  let logOpens = 0;
  try {
    writeStatus(root);
    fs.writeFileSync(path.join(root, 'fleet.log'), 'строка\n'.repeat(100));
    const dir = path.join(root, '.runtime', 'results');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 12; i++)
      fs.writeFileSync(
        path.join(dir, `${String(i).padStart(8, '0')}-uuid.json`),
        JSON.stringify({ ok: false, error: `e${i}` }),
      );

    const resultsDir = path.resolve(dir);
    const logFile = path.resolve(path.join(root, 'fleet.log'));
    fs.readdirSync = function (target, ...rest) {
      if (path.resolve(String(target)) === resultsDir) readdirCalls++;
      return originalReaddir.call(fs, target, ...rest);
    };
    fs.openSync = function (target, ...rest) {
      if (path.resolve(String(target)) === logFile) logOpens++;
      return originalOpen.call(fs, target, ...rest);
    };

    const cache = { log: null, commandErrors: null, commandErrorsAt: 0 };
    const first = watch.collectFrame({ root, options: { logLines: 3 }, width: 80, cache });
    const afterFirst = { readdirCalls, logOpens };
    const second = watch.collectFrame({ root, options: { logLines: 3 }, width: 80, cache });

    assert.ok(afterFirst.readdirCalls >= 1, 'первый кадр читает каталог результатов');
    assert.equal(readdirCalls, afterFirst.readdirCalls, 'второй кадр берёт результаты из кэша');
    assert.equal(logOpens, afterFirst.logOpens, 'второй кадр берёт лог из кэша');
    assert.deepEqual(second.log, first.log);
    assert.deepEqual(second.commandErrors, first.commandErrors);
  } finally {
    fs.readdirSync = originalReaddir;
    fs.openSync = originalOpen;
    clean(root);
  }
});

test('accounts/index.json необязателен, а при наличии дополняет имена', () => {
  const root = tempRoot();
  try {
    writeStatus(root, {
      bots: [
        { index: 2, status: 'online', attempts: 1 },
        { index: 7, status: 'queued', attempts: 0 },
      ],
    });
    let frame = watch.collectFrame({ root, width: 80 });
    assert.equal(frame.registry.present, false);
    assert.equal(frame.bots[0].name, null);

    fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'accounts', 'index.json'),
      JSON.stringify({ accounts: [{ index: 2, name: 'Из реестра', tag: '#REG' }] }),
    );
    frame = watch.collectFrame({ root, width: 80 });
    assert.equal(frame.registry.present, true);
    assert.equal(frame.registry.count, 1);
    assert.equal(frame.bots[0].name, 'Из реестра');
    assert.equal(frame.bots[0].tag, '#REG');
    assert.equal(frame.bots[1].name, null);
  } finally {
    clean(root);
  }
});

test('ошибки последних команд читаются из .runtime/results', () => {
  const root = tempRoot();
  try {
    writeStatus(root);
    const dir = path.join(root, '.runtime', 'results');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ ok: false, error: 'Бот ещё не вошёл' }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ ok: true, result: [{ index: 1, error: 'таймаут' }] }));
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ ok: true, result: [{ index: 1, ok: true }] }));
    const frame = watch.collectFrame({ root, width: 80 });
    assert.equal(frame.commandErrors.length, 2);
    const text = watch.renderFrame(frame);
    assert.match(text, /ошибки команд: 2/);
    assert.match(text, /Бот ещё не вошёл/);
  } finally {
    clean(root);
  }
});

test('битый fleet-status.json не роняет дашборд', () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, 'fleet-status.json'), '{ не json');
    const frame = watch.collectFrame({ root, width: 80 });
    assert.equal(frame.statusFile.present, false);
    assert.ok(frame.statusFile.error);
    assert.match(watch.renderFrame(frame), /повреждён/);
  } finally {
    clean(root);
  }
});
