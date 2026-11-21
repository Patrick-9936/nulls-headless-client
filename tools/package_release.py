"""Build a portable release without account tokens, proxies, captures or runtime state.

Two modes:
  python3 tools/package_release.py          build zip into the repository parent and
                                            Nulls.js into both the parent and the root
  python3 tools/package_release.py --check  build into a temporary directory only and
                                            compare the bundle hash with the committed
                                            Nulls.js; exit code 1 on any difference

The bundle is deterministic: npm-generated files inside node_modules are excluded, only
production packages from package-lock.json are shipped (devDependencies are dropped),
and gzip is written with mtime=0, so the same sources always produce the same sha256.
"""
import base64
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]

DIRECTORIES = {'Crypto', 'DataStream', 'Messaging', 'utils', 'lib', 'data', 'tools', 'tests', 'node_modules', '.devcontainer'}
FILES = {'Program.js', 'TUI.js', 'package.json', 'package-lock.json', 'config.json', 'client-license.bin', '.gitignore'}
# Из docs/ в релиз идёт только то, что клиент читает в рантайме:
#   features.json         — lib/CLI.js (команда features), TUI.js
#   protocol-evidence.json— lib/Protocol.js (версии пакетов при encode)
#   TUI.md, COMMANDS.md   — TUI.js, пункты меню «руководство» и «команды»
# docs/native/ — выдержки для разработки, docs/*.md — документация; рантайм их не читает.
DOC_FILES = {'docs/features.json', 'docs/protocol-evidence.json', 'docs/TUI.md', 'docs/COMMANDS.md'}
EXCLUDED_DIRS = {'.git', '__pycache__', 'PacketsDumps', '.verification', '.runtime', '.updates'}
EXCLUDED_SUFFIXES = {'.zip', '.pyc', '.log', '.pid', '.lock', '.raw'}
ZIP_DATE = (1980, 1, 1, 0, 0, 0)  # fixed timestamp keeps repeated zips byte-identical


def npm_artifact(rel: Path) -> bool:
    """npm rewrites these on every install (lock state, caches); never part of a release."""
    parts = rel.parts
    if 'node_modules' not in parts:
        return False
    tail = parts[parts.index('node_modules') + 1:]
    if not tail:
        return False
    # Only the top-level npm bookkeeping and cache trees; package contents stay intact.
    if tail[0] in {'.package-lock.json', '.cache', '.bin'}:
        return True
    return any(part == '.cache' for part in tail[1:])


def production_packages(root: Path) -> set:
    """Package keys from package-lock.json that belong to production dependencies.

    npm marks dev-only entries with `dev: true`; `devOptional` marks optional
    packages that npm also assigns to the dev tree. Everything else, including
    the transitive closure of `dependencies`, is production.
    """
    lock = json.loads((root / 'package-lock.json').read_text())
    production = set()
    for key, meta in lock.get('packages', {}).items():
        if not key or not meta:
            continue
        if meta.get('dev') or meta.get('devOptional'):
            continue
        production.add(key)
    return production


def package_keys(rel: Path) -> list:
    """Lockfile keys of the package(s) owning a node_modules path, outermost first."""
    parts = rel.parts
    keys = []
    for index, part in enumerate(parts):
        if part != 'node_modules' or index + 1 >= len(parts):
            continue
        name_end = index + 2
        if parts[index + 1].startswith('@') and name_end < len(parts):
            name_end += 1
        keys.append('/'.join(parts[:name_end]))
    return keys


def collect(root: Path, files: set, directories: set, production: set):
    entries = []
    # Sort by POSIX path, not by Path object, so the order is identical on every OS.
    for p in sorted(root.rglob('*'), key=lambda item: item.relative_to(root).as_posix()):
        rel = p.relative_to(root)
        if not p.is_file() or p.is_symlink():
            continue
        if any(x in EXCLUDED_DIRS for x in rel.parts):
            continue
        if rel.as_posix() not in files and rel.parts[0] not in directories:
            continue
        if p.suffix in EXCLUDED_SUFFIXES:
            continue
        if npm_artifact(rel):
            continue
        keys = package_keys(rel)
        if keys and any(key not in production for key in keys):
            continue
        entries.append((rel, p.read_bytes()))
    return entries


def write_zip(archive: Path, prefix: str, entries) -> None:
    with ZipFile(archive, 'w', ZIP_DEFLATED) as z:
        for rel, data in entries:
            info = ZipInfo(f'{prefix}/{rel.as_posix()}', date_time=ZIP_DATE)
            info.external_attr = 0o100644 << 16
            info.compress_type = ZIP_DEFLATED
            z.writestr(info, data)


def verify_zip(archive: Path, prefix: str, config: dict, license_path: Path, production: set) -> int:
    with ZipFile(archive) as z:
        assert z.testzip() is None
        names = z.namelist()
        assert not any('/accounts/' in name or '/.verification/' in name or '/PacketsDumps/' in name or '/.runtime/' in name for name in names)
        assert f'{prefix}/account.json' not in names
        assert len(z.read(f'{prefix}/{license_path.as_posix()}')) >= 58
        assert json.loads(z.read(f'{prefix}/config.json'))['host'] == 'brawl.server.dnull.xyz'
        assert f'{prefix}/lib/Client.js' in names
        # Из docs/ в бандле только рантайм-файлы: allowlist, без выдержек native.
        assert any(name.startswith(f'{prefix}/tests/') for name in names), 'tests/ должны входить: node Nulls.js --test'
        for doc in sorted(DOC_FILES):
            assert f'{prefix}/{doc}' in names, f'missing runtime doc {doc}'
        shipped_docs = {name[len(prefix) + 1:] for name in names if name.startswith(f'{prefix}/docs/')}
        assert shipped_docs == DOC_FILES, f'unexpected docs entries: {sorted(shipped_docs - DOC_FILES)}'
        assert not any('/docs/native/' in name for name in names), 'docs/native/ must not ship'
        assert f'{prefix}/node_modules/.package-lock.json' not in names
        assert not any('/node_modules/.bin/' in name for name in names)
        # Inside node_modules only production packages may appear; dev trees stay out.
        top_level = {key for key in production if key.startswith('node_modules/') and key.count('node_modules') == 1}
        for key in sorted(top_level):
            assert f'{prefix}/{key}/package.json' in names, f'missing production package {key}'
        for name in names:
            rel = Path(name[len(prefix) + 1:])
            if 'node_modules' not in rel.parts:
                continue
            keys = package_keys(rel)
            assert keys and all(key in production for key in keys), f'unexpected dependency file {name}'
    return len(names)


def bundle_bytes(version: str, entries) -> bytes:
    payload_entries = [{
        'path': rel.as_posix(),
        'base64': base64.b64encode(data).decode('ascii'),
        'sha256': hashlib.sha256(data).hexdigest(),
    } for rel, data in entries]
    return json.dumps({'version': version, 'files': payload_entries}, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def build_bundle(version: str, entries) -> bytes:
    bundle = bundle_bytes(version, entries)
    payload = base64.b64encode(gzip.compress(bundle, mtime=0)).decode('ascii')
    digest = hashlib.sha256(bundle).hexdigest()
    template = (ROOT / 'tools/single-file.template').read_text()
    assert template.count('__PAYLOAD__') == 1 and template.count('__DIGEST__') == 1 and template.count('__VERSION__') == 1
    single = template.replace('__PAYLOAD__', payload).replace('__DIGEST__', digest).replace('__VERSION__', version)
    return single.encode('utf-8')


def read_committed(path: Path):
    """Return (version, {path: sha256}, content digest) from an already built Nulls.js."""
    text = path.read_text()
    payload = re.search(r"const PAYLOAD='([A-Za-z0-9+/=]+)'", text)
    version = re.search(r"const VERSION='([^']*)'", text)
    digest = re.search(r"const PAYLOAD='[^']*',DIGEST='([0-9a-f]{64})'", text)
    if not payload or not version or not digest:
        raise SystemExit(f'cannot read bundle payload from {path}')
    bundle = json.loads(gzip.decompress(base64.b64decode(payload.group(1))))
    return version.group(1), {entry['path']: entry['sha256'] for entry in bundle['files']}, digest.group(1)


def write_single(single: Path, single_bytes: bytes) -> str:
    single.write_bytes(single_bytes)
    single_hash = hashlib.sha256(single_bytes).hexdigest()
    single.with_suffix('.js.sha256').write_text(single_hash + '  ' + single.name + '\n')
    return single_hash


def check(version: str, entries, single_bytes: bytes) -> int:
    committed = ROOT / 'Nulls.js'
    if not committed.is_file():
        print(json.dumps({'check': 'failed', 'reason': 'Nulls.js is not committed'}))
        return 1
    committed_version, committed_entries, committed_digest = read_committed(committed)
    expected_hash = hashlib.sha256(single_bytes).hexdigest()
    committed_hash = hashlib.sha256(committed.read_bytes()).hexdigest()
    expected_digest = hashlib.sha256(bundle_bytes(version, entries)).hexdigest()
    license_path = Path(license_path_value())
    config = json.loads((ROOT / 'config.json').read_text())
    prefix = prefix_value(version)
    tmp = Path(tempfile.mkdtemp(prefix='nulls-bundle-', dir=os.environ.get('TMPDIR')))
    try:
        # The whole release is built here; nothing in the working tree is touched.
        archive = tmp / f'{prefix}.zip'
        write_zip(archive, prefix, entries)
        verify_zip(archive, prefix, config, license_path, production_packages(ROOT))
        write_single(tmp / 'Nulls.js', single_bytes)
        zip_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    expected = {rel.as_posix(): hashlib.sha256(data).hexdigest() for rel, data in entries}
    changed = sorted(p for p in set(expected) | set(committed_entries) if expected.get(p) != committed_entries.get(p))
    # Сравниваем хеш содержимого, а не байты обёртки: gzip-поток зависит от версии
    # zlib в системе, поэтому base64-payload и sha256 файла различаются между
    # Termux/ARM и ubuntu/x64 при полностью идентичных исходниках.
    content_ok = expected_digest == committed_digest
    ok = content_ok and committed_version == version and not changed
    result = {
        'check': 'ok' if ok else 'failed',
        'version': version,
        'committed_version': committed_version,
        'files': len(expected),
        'committed_files': len(committed_entries),
        'content_sha256': expected_digest,
        'committed_content_sha256': committed_digest,
        'expected_sha256': expected_hash,
        'committed_sha256': committed_hash,
        'zip_sha256': zip_hash,
        'changed': changed[:20],
    }
    if ok and expected_hash != committed_hash:
        result['note'] = 'обёртка пересобрана другой версией zlib; содержимое совпадает'
    print(json.dumps(result))
    return 0 if ok else 1


def license_path_value() -> str:
    return json.loads((ROOT / 'config.json').read_text())['clientLicensePath']


def prefix_value(version: str) -> str:
    return f'nulls-headless-client-{version}'


def main(argv) -> int:
    version = json.loads((ROOT / 'package.json').read_text())['version']
    prefix = prefix_value(version)
    config = json.loads((ROOT / 'config.json').read_text())
    license_path = Path(config['clientLicensePath'])
    assert not license_path.is_absolute() and '..' not in license_path.parts

    entries = collect(ROOT, set(FILES) | DOC_FILES | {license_path.as_posix()}, DIRECTORIES, production_packages(ROOT))
    single_bytes = build_bundle(version, entries)

    if '--check' in argv:
        return check(version, entries, single_bytes)

    archive = ROOT.parent / f'{prefix}.zip'
    write_zip(archive, prefix, entries)
    names = verify_zip(archive, prefix, config, license_path, production_packages(ROOT))
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(checksum + '  ' + archive.name + '\n')
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size, 'files': names, 'sha256': checksum}))

    single = ROOT.parent / 'Nulls.js'
    single_hash = write_single(single, single_bytes)
    write_single(ROOT / 'Nulls.js', single_bytes)
    print(json.dumps({'single': str(single), 'bytes': single.stat().st_size, 'files': len(entries), 'sha256': single_hash}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))