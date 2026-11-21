const fs = require('fs');
const path = require('path');
const { AppError, codes, fromFilesystem } = require('../lib/Errors');

function apply(config, root) {
  const file = path.resolve(root, config.clientLicensePath || 'client-license.bin');
  let license;
  try {
    license = fs.readFileSync(file);
  } catch (error) {
    throw fromFilesystem(error, { file });
  }
  // Неверный блок — LICENSE_INVALID. В details только размеры, не содержимое.
  if (license.length < 58) {
    throw new AppError(codes.LICENSE_INVALID, 'Invalid installed Nulls APK license block', {
      details: { file, expected: 58, actual: license.length, reason: 'too-short' },
    });
  }
  const declared = license.readUInt16LE(56);
  if (declared > license.length - 58) {
    throw new AppError(codes.LICENSE_INVALID, 'Invalid installed Nulls APK license block', {
      details: { file, expected: license.length - 58, actual: declared, reason: 'tail-out-of-range' },
    });
  }
  if (!Number.isSafeInteger(config.apkSize) || config.apkSize <= 0) {
    throw new AppError(codes.INVALID_CONFIG, 'Nulls APK size is required', {
      details: { field: 'apkSize', file },
    });
  }
  config.loginClientSeed = (config.apkSize ^ 4330295) | 0;
  config.createHelloExtra = () =>
    Buffer.concat([
      license,
      Buffer.from(
        JSON.stringify({
          features: ['high_memory'],
          timestamp: Date.now(),
          connection: 'Keep-Alive',
          modificationIds: [],
        }) + '\0',
      ),
    ]);
  return config;
}

module.exports = { apply };
