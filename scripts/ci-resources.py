"""Record a complete bounded CI stage forecast before installing or running tools."""
import json
import os
from pathlib import Path
import sys
import time

stage = sys.argv[1]
Path('artifacts').mkdir(exist_ok=True)
info = {}
for line in Path('/proc/meminfo').read_text().splitlines():
    key, value = line.split(':', 1)
    if value.strip().endswith('kB'):
        info[key] = int(value.split()[0]) / 1024**2
disk = os.statvfs('.')
memory, growth, minutes = (1.5, 3, 15) if stage == 'package' else (3, 24, 20)
snapshot = {'sampled_at': time.time(), 'stage': stage, 'total_memory_gib': info['MemTotal'], 'available_memory_gib': info['MemAvailable'],
            'disk_free_gib': disk.f_bavail * disk.f_frsize / 2**30,
            'forecast': {'remaining_minutes_upper_bound': minutes, 'peak_memory_gib': memory, 'disk_growth_gib': growth, 'memory_reserve_gib': 1, 'disk_reserve_gib': 3, 'concurrency': 1},
            'remaining_work': ['runtime prerequisites', 'locked npm dependencies', 'prepack checks and serial tests', 'candidate artifact checks'] if stage == 'package' else ['official image metadata', 'guarded image acquisition', 'tool and platform library reads', 'lock and drift check'],
            'rtl_to_gds': False}
Path('artifacts/' + stage + '-resources.json').write_text(json.dumps(snapshot, indent=2) + '\n')
print(json.dumps(snapshot, indent=2))
if info['MemAvailable'] < memory + 1 or snapshot['disk_free_gib'] < growth + 3:
    raise SystemExit('CI stage blocked by measured resources; no workload launched')
