const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');
const { execFileSync } = require('child_process');
const Inspector = require('./LibgInspector');
const Transport = require('./UpdateTransport');
const Platform = require('./Platform');
const { AppError, codes } = require('../lib/Errors');
const clone = (x) => JSON.parse(JSON.stringify(x));
const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fields = [
  'appBinaryVersion',
  'clientMajor',
  'clientMinor',
  'clientBuild',
  'major',
  'minor',
  'build',
  'fingerprintHash',
  'protocolVersion',
  'keyVersion',
  'serverPublicKeyHex',
  'apkSize',
  'clientLicensePath',
];
function fingerprintInto(config, fp) {
  if (!fp || !/^\d+\.\d+\.\d+$/.test(String(fp.version)) || !/^([a-f\d]{40})$/i.test(String(fp.sha)))
    throw new AppError(codes.STATE_ERROR, 'Invalid server fingerprint; config preserved', {
      kind: 'server',
      details: { field: 'fingerprint', reason: 'format' },
    });
  const v = fp.version.split('.').map(Number);
  if (v.some((x) => !Number.isSafeInteger(x) || x > 0x7fffffff))
    throw new AppError(codes.STATE_ERROR, 'Invalid content version', {
      kind: 'server',
      details: { field: 'version', reason: 'range' },
    });
  Object.assign(config, { major: v[0], minor: v[1], build: v[2], fingerprintHash: fp.sha });
  return config;
}
function candidateFromAPK(current, meta, lib) {
  const c = clone(current),
    v = meta.appVersion.split('.').map(Number);
  if (v.length !== 2 || v.some((x) => !Number.isInteger(x) || x < 0 || x > 0x7fffffff))
    throw new AppError(codes.INVALID_ARGUMENT, 'Invalid APK version', {
      details: { field: 'appVersion', value: meta.appVersion ?? null },
    });
  if (
    v[0] < (current.clientMajor ?? current.major) ||
    (v[0] === (current.clientMajor ?? current.major) && v[1] < (current.clientBuild ?? current.build))
  )
    return { config: c, constants: {}, keyExtracted: false, installedOlder: true };
  Object.assign(c, {
    appBinaryVersion: meta.appVersion,
    clientMajor: v[0],
    clientMinor: 0,
    clientBuild: v[1],
    serverPublicKeyHex: current.serverPublicKeyHex,
  });
  let keyExtracted = false;
  try {
    c.serverPublicKeyHex = Inspector.extractSpkFromBuffer(lib).keyHex;
    keyExtracted = true;
  } catch (e) {
    if (!/SPK marker not found/.test(e.message)) throw e;
  }
  const constants = Inspector.extractHelloConstants(lib);
  for (const k of ['protocolVersion', 'keyVersion']) if (constants[k]?.length === 1) c[k] = constants[k][0];
  if (c.cryptoMode === 'nulls-native19') c.apkSize = meta.apkSize;
  return { config: c, constants, keyExtracted };
}
function atomicWrite(file, bytes) {
  const tmp = file + '.update-' + process.pid;
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function commit(root, before, candidate) {
  const file = path.join(root, 'config.json');
  if (fs.readFileSync(file, 'utf8') !== before)
    throw new AppError(codes.STATE_ERROR, 'config.json changed during verification; update cancelled', {
      details: { file: 'config.json', reason: 'changed-during-verification' },
    });
  const backup = path.join(
    root,
    '.updates',
    'backups',
    Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.json',
  );
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, before, { mode: 0o600 });
  atomicWrite(file, JSON.stringify(candidate, null, 2) + '\n');
  return path.relative(root, backup);
}
function lock(root) {
  const p = path.join(root, '.updates', 'update.lock');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    fs.writeFileSync(p, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(p, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1)
      throw new AppError(codes.STATE_ERROR, 'Invalid updater lock; inspect .updates/update.lock', {
        details: { file: path.relative(root, p) },
      });
    try {
      process.kill(pid, 0);
      throw new AppError(codes.STATE_ERROR, 'Another updater is running', {
        retryable: true,
        details: { file: path.relative(root, p), pid },
      });
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
    fs.unlinkSync(p);
    fs.writeFileSync(p, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  return () => {
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === String(process.pid)) fs.unlinkSync(p);
  };
}
function readAPK(root, current, opts, stage) {
  if (opts.noAPK) return null;
  const pkg =
    current.appPackage ||
    (current.cryptoMode === 'nulls-native19' ? 'daniillnull.nulls.brawlstars' : 'com.supercell.brawlstars');
  let base = opts.apk,
    libs = opts.splitAPK;
  if (!base) {
    if (!Platform.supportsApkUpdate()) return null;
    const apks = execFileSync('/system/bin/pm', ['path', pkg], { encoding: 'utf8', timeout: 10000 })
      .trim()
      .split(/\r?\n/)
      .filter((x) => x.startsWith('package:'))
      .map((x) => x.slice(8));
    base = apks.find((p) => path.basename(p) === 'base.apk');
    libs = apks.find((p) => path.basename(p) === 'split_config.arm64_v8a.apk') || base;
    if (!base)
      throw new AppError(codes.PLATFORM_UNSUPPORTED, 'Install/update ' + pkg + ' or supply --apk FILE', {
        details: { package: pkg, platform: process.platform },
      });
  }
  base = path.resolve(base);
  libs = libs ? path.resolve(libs) : base;
  // PYTHON_MISSING: текст сообщения совпадает с прежним throw.
  const python = Platform.requirePython();
  const meta = JSON.parse(
    execFileSync(python, ['-P', path.join(root, 'tools/extract_update_apk.py'), base, libs, stage, pkg], {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
  const lib = fs.readFileSync(meta.libgPath);
  fs.unlinkSync(meta.libgPath);
  const result = candidateFromAPK(current, meta, lib);
  if (opts.libg) {
    result.config.serverPublicKeyHex = Inspector.extractSpkFromBuffer(fs.readFileSync(path.resolve(opts.libg))).keyHex;
    result.keyExtracted = true;
  }
  return { ...result, meta };
}
function prepared(root, c) {
  if (c.cryptoMode === 'nulls-native19') require('./NullsLicense').apply(c, root);
  return c;
}
async function runUpdate(root, opts = {}, deps = {}) {
  const release = lock(root),
    file = path.join(root, 'config.json');
  let before, current;
  const stage = path.join(root, '.updates', Date.now() + '-' + crypto.randomBytes(3).toString('hex'));
  let preserveStage = false,
    accountLock;
  try {
    before = fs.readFileSync(file, 'utf8');
    current = JSON.parse(before);
    if (opts.rollback) {
      const dir = path.join(root, '.updates/backups'),
        names = fs.existsSync(dir)
          ? fs
              .readdirSync(dir)
              .filter((x) => x.endsWith('.json'))
              .sort()
          : [];
      if (!names.length)
        throw new AppError(codes.STATE_ERROR, 'No update backup available', {
          details: { dir: path.join('.updates', 'backups') },
        });
      const restored = JSON.parse(fs.readFileSync(path.join(dir, names.at(-1)), 'utf8'));
      prepared(root, clone(restored));
      const backup = commit(root, before, restored);
      return { status: 'rolled-back', backup };
    }
    if (!['native19', 'nulls-native19'].includes(current.cryptoMode))
      throw new AppError(codes.INVALID_CONFIG, 'Updater supports the verified Native19 clients only', {
        details: { field: 'cryptoMode', cryptoMode: current.cryptoMode ?? null },
      });
    fs.mkdirSync(stage, { recursive: true });
    const apk = (deps.readAPK || readAPK)(root, current, opts, stage);
    const candidate = apk ? apk.config : clone(current);
    if (apk?.meta?.licensePath && !apk.installedOlder) {
      const bytes = fs.readFileSync(apk.meta.licensePath),
        old = path.resolve(root, current.clientLicensePath || 'client-license.bin');
      if (!fs.existsSync(old) || digest(bytes) !== digest(fs.readFileSync(old)))
        candidate.clientLicensePath = path.relative(root, apk.meta.licensePath);
    }
    const network = deps.network || Transport;
    const response = await network.fingerprint(prepared(root, clone(candidate)));
    if (response.status === 7) fingerprintInto(candidate, response.fingerprint);
    else if (response.status !== null)
      throw new AppError(
        codes.STATE_ERROR,
        `Server rejected update probe (code ${response.status}); newer installed APK or protocol analysis may be needed`,
        { kind: 'server', details: { serverCode: response.status, endpoint: 'fingerprint' } },
      );
    const changes = fields
      .filter((k) => JSON.stringify(current[k]) !== JSON.stringify(candidate[k]))
      .map((k) => ({ field: k, before: current[k] ?? null, after: candidate[k] ?? null }));
    const full = (!opts.check && changes.length > 0) || opts.verifyLogin;
    let account = null;
    if (full) {
      const accountFile = path.resolve(root, opts.account || 'account.json');
      accountLock = new (require('../lib/AccountLock'))(accountFile);
      accountLock.acquire();
      account = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
    }
    const verification = await network.verify(prepared(root, clone(candidate)), account, root, { helloOnly: !full });
    if (full && !(verification.loginOk && verification.homeData))
      throw new AppError(codes.STATE_ERROR, 'Login/HomeData not confirmed; config preserved', {
        kind: 'server',
        details: { endpoint: 'verify' },
      });
    const report = {
      status: changes.length ? (opts.check ? 'update-available' : 'updated') : 'up-to-date',
      appVersion: candidate.appBinaryVersion,
      contentVersion: `${candidate.major}.${candidate.minor}.${candidate.build}`,
      apkRead: !!apk,
      extractedHelloConstants: apk?.constants || {},
      publicKeyExtracted: apk?.keyExtracted ?? false,
      installedAPKVersion: apk?.meta?.appVersion ?? null,
      installedAPKOlder: apk?.installedOlder ?? false,
      changes,
      verification,
    };
    if (changes.length && !opts.check) {
      candidate.lastAutomaticUpdate = { at: new Date().toISOString(), verification };
      report.backup = commit(root, before, candidate);
      preserveStage = String(candidate.clientLicensePath || '').startsWith(path.relative(root, stage) + path.sep);
    }
    return report;
  } finally {
    accountLock?.release();
    if (!preserveStage && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    release();
  }
}
function parseArgs(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['--check', '--watch', '--rollback', '--no-apk', '--verify-login', '--help'].includes(a)) {
      o[{ '--no-apk': 'noAPK', '--verify-login': 'verifyLogin' }[a] || a.slice(2)] = true;
      continue;
    }
    const key = {
      '--account': 'account',
      '--apk': 'apk',
      '--split-apk': 'splitAPK',
      '--interval': 'interval',
      '--libg': 'libg',
    }[a];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new AppError(codes.INVALID_ARGUMENT, 'Unknown/missing updater option ' + a, {
        details: { option: a },
      });
    o[key] = args[++i];
  }
  if (o.rollback && (o.check || o.watch))
    throw new AppError(codes.INVALID_ARGUMENT, '--rollback cannot be combined with --check/--watch', {
      details: { arguments: ['rollback', 'check', 'watch'] },
    });
  o.interval = Number(o.interval || 1800);
  if (!Number.isInteger(o.interval) || o.interval < 60 || o.interval > 86400)
    throw new AppError(codes.INVALID_ARGUMENT, '--interval must be 60–86400 seconds', {
      details: { argument: 'interval', value: o.interval ?? null },
    });
  return o;
}
async function main(root, args = process.argv.slice(2)) {
  try {
    const opts = parseArgs(args);
    if (opts.help) {
      console.log(
        'update [--check] [--watch --interval 1800] [--verify-login] [--account FILE] [--apk BASE.apk --split-apk ARM64.apk] [--libg CURRENT_NATIVE_DUMP] [--no-apk] [--rollback]',
      );
      return;
    }
    if (!opts.watch) {
      console.log(JSON.stringify(await runUpdate(root, opts), null, 2));
      return;
    }
    let stop = false,
      wake;
    const halt = () => {
      stop = true;
      wake?.();
    };
    process.once('SIGINT', halt);
    process.once('SIGTERM', halt);
    // Windows: Ctrl+Break приходит как SIGBREAK.
    if (Platform.isWindows()) process.once('SIGBREAK', halt);
    try {
      while (!stop) {
        try {
          console.log(JSON.stringify(await runUpdate(root, opts)));
        } catch (e) {
          console.error('Update check failed: ' + e.message + '; current config retained');
        }
        if (!stop)
          await new Promise((resolve) => {
            const t = setTimeout(resolve, opts.interval * 1000);
            wake = () => {
              clearTimeout(t);
              resolve();
            };
          });
      }
    } finally {
      process.off('SIGINT', halt);
      process.off('SIGTERM', halt);
      if (Platform.isWindows()) process.off('SIGBREAK', halt);
    }
  } catch (e) {
    console.error('Update failed: ' + e.message + '; current config retained');
    process.exitCode = 1;
  }
}
module.exports = { main, runUpdate, fingerprintInto, candidateFromAPK, commit, parseArgs };
