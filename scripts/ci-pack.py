"""Build the candidate once, retaining native reports and checking its thin contents."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tarfile
import time

out = Path('artifacts').resolve()
out.mkdir(exist_ok=True)
start = time.monotonic()
peak = 0
reason = None
with (out/'pack.stdout.log').open('w') as stdout, (out/'pack.stderr.log').open('w') as stderr:
    process = subprocess.Popen(['npm', 'pack', '--json', '--pack-destination', str(out)], stdout=stdout, stderr=stderr, start_new_session=True)
    try:
        while process.poll() is None:
            rows = [list(map(int, row.split())) for row in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss='], text=True).splitlines() if row.strip()]
            owned = {process.pid}
            while True:
                more = {p for p, parent, _ in rows if parent in owned}
                if more <= owned:
                    break
                owned |= more
            peak = max(peak, sum(rss*1024 for p, _, rss in rows if p in owned))
            if peak > 1.5 * 2**30 or time.monotonic()-start > 600 or os.statvfs('.').f_bavail * os.statvfs('.').f_frsize < 3 * 2**30:
                reason = 'CI candidate process-tree/time/disk limit exceeded'
                break
            time.sleep(0.2)
    except BaseException as error:
        reason = type(error).__name__ + ': ' + str(error)
    if reason:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    code = process.wait()
summary = {'exit_code': code, 'reason': reason, 'wall_seconds': round(time.monotonic()-start, 3), 'sampled_process_tree_peak_gib': peak/2**30}
(out/'pack-run.json').write_text(json.dumps(summary, indent=2)+'\n')
print(json.dumps(summary))
if code or reason:
    print((out/'pack.stdout.log').read_text()[-20000:])
    print((out/'pack.stderr.log').read_text()[-10000:])
    raise SystemExit(1)
raw = (out/'pack.stdout.log').read_text()
pack = None
for match in reversed(list(re.finditer(r'(?m)^\[', raw))):
    try:
        parsed = json.loads(raw[match.start():])
        if isinstance(parsed, list) and parsed and parsed[0].get('name') == 'dsh-rtl-flow':
            pack = parsed[0]
            break
    except (ValueError, AttributeError):
        pass
assert pack
count = lambda name: int(re.search(r'(?:#|ℹ)\s*' + name + r'\s+(\d+)\b', raw).group(1))
assert count('tests') == count('pass') and count('fail') == 0 and count('skipped') == 0 and count('cancelled') == 0
blob = (out/pack['filename']).read_bytes()
assert pack['integrity'] == 'sha512-' + base64.b64encode(hashlib.sha512(blob).digest()).decode()
assert len(blob) < 1024**2
with tarfile.open(out/pack['filename']) as archive:
    for member in archive.getmembers():
        if not member.isfile():
            continue
        path = Path(member.name).relative_to('package')
        assert '..' not in path.parts and not path.is_absolute()
        assert path.parts[0] not in {'tests', 'reports', 'node_modules', '.local', '.cache', '.github'}
        assert path.suffix.lower() not in {'.gds', '.lef', '.lib', '.odb', '.spef', '.dmg', '.tgz', '.so', '.node', '.pyc'}
        assert path.name not in {'.npmrc', '.env'}
        assert archive.extractfile(member).read() == path.read_bytes()
        if str(path) == 'bin/rtl-flow.js':
            assert member.mode & 0o111
candidate = {'name': pack['name'], 'version': pack['version'], 'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
             'filename': pack['filename'], 'bytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest(), 'shasum': pack['shasum'], 'integrity': pack['integrity'],
             'tests': count('tests'), 'passed': count('pass'), 'failed': 0, 'skipped': 0, 'entry_count': pack['entryCount'], 'pack_run': summary,
             'body_files_equal_source': True, 'eda_pdk_bodies_included': False, 'rtl_to_gds_verified': False}
(out/'candidate.json').write_text(json.dumps(candidate, indent=2)+'\n')
(out/'SHA256SUMS').write_text(candidate['sha256'] + '  ' + candidate['filename'] + '\n')
print(json.dumps(candidate, indent=2))
