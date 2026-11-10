"""Create a minimal unpacked-extension zip with no development dependencies."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
out = root / 'dist'
out.mkdir(exist_ok=True)
version = json.loads((root/'manifest.json').read_text())['version']
target = out / f'续聊-{version}-Chromium.zip'
files = [root/'manifest.json', root/'background.js', root/'README.md']
for folder in ('lib', 'content', 'ui', 'data', 'icons', 'docs'):
    files.extend(p for p in (root/folder).rglob('*') if p.is_file())
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for item in sorted(files):
        archive.write(item, Path('xuliao-extension')/item.relative_to(root))
    assert archive.testzip() is None
digest = hashlib.sha256(target.read_bytes()).hexdigest()
(out/'SHA256.txt').write_text(f'{digest}  {target.name}\n')
print(target)
print(f'{target.stat().st_size:,} bytes; SHA256 {digest}')
