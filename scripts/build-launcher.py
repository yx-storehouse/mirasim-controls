"""Build the one-time, version-independent Windows launcher bundle."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parent.parent
NAME = 'Mirasim-Controls-AutoUpdate'
FILES = ['01-安装或修复.bat', '02-查看状态.bat', '03-恢复原版.bat', '04-导出兼容报告.bat', 'bootstrap.ps1']


def build():
    data = {name: (ROOT / name).read_bytes() for name in FILES}
    if not data['bootstrap.ps1'].startswith(b'\xef\xbb\xbf'):
        raise ValueError('bootstrap.ps1 must preserve its UTF-8 BOM')
    data['使用说明.md'] = (ROOT / 'docs/launcher-usage.md').read_bytes()
    data['SHA256SUMS.txt'] = ''.join(
        f'{hashlib.sha256(content).hexdigest()}  {name}\n'
        for name, content in data.items()
    ).encode('utf-8')
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    archive = output / f'{NAME}.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, content in data.items():
            z.writestr(f'{NAME}/{name}', content)
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        for name, content in data.items():
            assert z.read(f'{NAME}/{name}') == content
    result = {'file': archive.name, 'bytes': archive.stat().st_size,
              'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'files': list(data)}
    (output / f'{NAME}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    build()
