"""Build a portable release without account tokens, proxies, captures or runtime state."""
import hashlib
import base64
import gzip
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text())['version']
prefix = f'nulls-headless-client-{version}'
archive = root.parent / f'{prefix}.zip'
directories = {'Crypto', 'DataStream', 'Messaging', 'TcpSocket', 'utils', 'lib', 'data', 'docs', 'tools', 'tests', 'node_modules', '.devcontainer'}
files = {'Program.js', 'TUI.js', 'package.json', 'package-lock.json', 'config.json', 'client-license.bin', 'README.md', 'PROTOCOL-MAP.md', '.gitignore'}
config = json.loads((root / 'config.json').read_text())
license_path = Path(config['clientLicensePath'])
assert not license_path.is_absolute() and '..' not in license_path.parts
files.add(license_path.as_posix())
entries = []
with ZipFile(archive, 'w', ZIP_DEFLATED) as z:
    for p in sorted(root.rglob('*')):
        rel = p.relative_to(root)
        if not p.is_file() or p.is_symlink() or any(x in {'.git', '__pycache__', 'PacketsDumps', '.verification', '.runtime', '.updates'} for x in rel.parts):
            continue
        if rel.as_posix() not in files and rel.parts[0] not in directories:
            continue
        if p.suffix in {'.zip', '.pyc', '.log', '.pid', '.lock', '.raw'}:
            continue
        z.write(p, f'{prefix}/{rel.as_posix()}')
        data = p.read_bytes()
        entries.append({'path': rel.as_posix(), 'base64': base64.b64encode(data).decode('ascii'), 'sha256': hashlib.sha256(data).hexdigest()})
with ZipFile(archive) as z:
    assert z.testzip() is None
    names = z.namelist()
    assert not any('/accounts/' in name or '/.verification/' in name or '/PacketsDumps/' in name or '/.runtime/' in name for name in names)
    assert f'{prefix}/account.json' not in names
    assert len(z.read(f'{prefix}/{license_path.as_posix()}')) >= 58
    assert json.loads(z.read(f'{prefix}/config.json'))['host'] == 'brawl.server.dnull.xyz'
    assert f'{prefix}/lib/Client.js' in names and f'{prefix}/docs/VERIFICATION.md' in names
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix('.zip.sha256').write_text(checksum + '  ' + archive.name + '\n')
print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size, 'files': len(names), 'sha256': checksum}))
bundle = json.dumps({'version': version, 'files': entries}, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
payload = base64.b64encode(gzip.compress(bundle, mtime=0)).decode('ascii')
digest = hashlib.sha256(bundle).hexdigest()
template = (root / 'tools/single-file.template').read_text()
assert template.count('__PAYLOAD__') == 1 and template.count('__DIGEST__') == 1
single = root.parent / 'Nulls.js'
single.write_text(template.replace('__PAYLOAD__', payload).replace('__DIGEST__', digest))
(root / 'Nulls.js').write_bytes(single.read_bytes())
single_hash = hashlib.sha256(single.read_bytes()).hexdigest()
single.with_suffix('.js.sha256').write_text(single_hash + '  ' + single.name + '\n')
print(json.dumps({'single': str(single), 'bytes': single.stat().st_size, 'files': len(entries), 'sha256': single_hash}))
