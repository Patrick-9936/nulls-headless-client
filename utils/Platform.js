const fs = require('node:fs');
const childProcess = require('node:child_process');
const { AppError, codes } = require('../lib/Errors');

// Кэш результата поиска Python: повторные вызовы не запускают процессы.
let python = undefined;

function isAndroid() {
  if (process.platform === 'android') return true;
  if (String(process.env.PREFIX || '').includes('com.termux')) return true;
  try {
    return fs.existsSync('/system/bin/pm');
  } catch {
    return false;
  }
}

function isWindows() {
  return process.platform === 'win32';
}

function isMac() {
  return process.platform === 'darwin';
}

function isLinux() {
  return process.platform === 'linux' || process.platform === 'android';
}

function hasPM() {
  try {
    return fs.existsSync('/system/bin/pm');
  } catch {
    return false;
  }
}

// Возвращает имя команды Python, которая действительно отвечает на --version, или null.
function pythonCommand() {
  if (python !== undefined) return python;
  const candidates = isWindows() ? ['python', 'python3'] : ['python3', 'python'];
  for (const command of candidates) {
    try {
      const output = childProcess.execFileSync(command, ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (/Python\s+\d+\.\d+/.test(output)) {
        python = command;
        return python;
      }
    } catch {}
  }
  python = null;
  return python;
}

// Android: termux-wake-lock/-unlock. Остальные платформы: no-op без запуска процессов.
function wakeLock(on) {
  if (!isAndroid()) return false;
  try {
    childProcess.execFileSync(on ? 'termux-wake-lock' : 'termux-wake-unlock', [], { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Обновление из установленного APK возможно только на Android с /system/bin/pm,
// либо когда APK передан явно (--apk/--split-apk) — тогда pm не нужен.
function supportsApkUpdate(options = {}) {
  const value = options || {};
  if (typeof value === 'string' ? value : value.apk || value.splitAPK) return true;
  return isAndroid() && hasPM();
}

// POSIX: chmod 0600. Windows: no-op, без исключения.
function fileModeSecure(file) {
  if (isWindows()) return false;
  try {
    fs.chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

// Python обязателен для обновления из APK: отдельный помощник для кода, которому
// нужен именно запуск, а не проверка. Сообщение совпадает с прежним текстом AutoUpdate.
function requirePython() {
  const command = pythonCommand();
  if (!command) {
    throw new AppError(
      codes.PYTHON_MISSING,
      'нужен python3: обновление из APK требует python (python3 на Linux/macOS)',
      {
        details: { platform: process.platform },
      },
    );
  }
  return command;
}

// Возможности, зависящие от платформы. Неизвестная возможность считается
// неподдерживаемой: список намеренно закрытый.
const FEATURES = {
  'apk-update': () => supportsApkUpdate(),
  'wake-lock': () => isAndroid(),
};

function supports(feature) {
  const probe = FEATURES[feature];
  return typeof probe === 'function' ? !!probe() : false;
}

function requireFeature(feature) {
  if (supports(feature)) return true;
  throw new AppError(codes.PLATFORM_UNSUPPORTED, `Платформа ${process.platform} не поддерживает: ${feature}`, {
    details: { platform: process.platform, feature },
  });
}

module.exports = {
  isAndroid,
  isWindows,
  isMac,
  isLinux,
  pythonCommand,
  requirePython,
  supports,
  requireFeature,
  wakeLock,
  supportsApkUpdate,
  fileModeSecure,
};
