"""Read-only ORFS tool/library probe. No DUT, synthesis, placement or routing."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def file_record(path, role):
    path = path.resolve(strict=True)
    if not path.is_file() or (path.stat().st_size == 0 and role != 'source_closure'):
        raise ValueError('Missing or empty ' + role)
    sha = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            sha.update(chunk)
    return {'path': str(path), 'role': role, 'sha256': sha.hexdigest(), 'bytes': path.stat().st_size}


def tcl_word(value):
    return '"' + re.sub(r'([\\"$\[\]])', r'\\\1', str(value)).replace('\n', '\\n').replace('\r', '\\r') + '"'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    request_path = Path(args.request).resolve(strict=True)
    output = Path(args.output).resolve()
    request = json.loads(request_path.read_text())
    report = {'schema_version': 1, 'status': 'fail', 'plan_identity': request['plan_identity'], 'tools': {}, 'files': [],
              'checks': [], 'rtl_to_gds_verified': False,
              'scope': 'Version checks and parsing platform LEF/Liberty/GDS libraries; no design implementation',
              'limitations': ['No RTL synthesis, placement, routing, STA, DRC, LVS, antenna or power acceptance']}
    try:
        root = Path(request['orfs_root']).resolve(strict=True)
        platform = (root / 'flow/platforms/nangate45').resolve(strict=True)
        platform.relative_to(root)
        if request['platform'] != 'nangate45':
            raise ValueError('Unsupported platform')
        roles = {}
        for role, relative in request['files'].items():
            path = (platform / relative).resolve(strict=True)
            path.relative_to(platform)
            roles[role] = path
            report['files'].append(file_record(path, role))
        gds = sorted((platform / 'gds').glob('*.gds'))
        if not gds:
            raise ValueError('Platform GDS library missing')
        for path in gds:
            path.resolve(strict=True).relative_to(platform)
            report['files'].append(file_record(path, 'gds'))
        for relative in ['env.sh', 'flow/Makefile', 'flow/util/docker_shell']:
            path = (root / relative).resolve(strict=True)
            path.relative_to(root)
            report['files'].append(file_record(path, 'orfs_source'))
        source_roots = [root / 'flow/scripts', root / 'flow/util', root / 'flow/platforms/common', platform]
        report['source_roots'] = [str(p) for p in source_roots]
        recorded = {f['path'] for f in report['files']}
        for directory in source_roots:
            if not directory.exists():
                continue
            for path in directory.rglob('*'):
                if path.is_file():
                    actual = path.resolve(strict=True)
                    actual.relative_to(root)
                    if str(actual) not in recorded:
                        if len(recorded) > 20000:
                            raise ValueError('Source/material closure exceeds probe entry limit')
                        report['files'].append(file_record(actual, 'source_closure'))
                        recorded.add(str(actual))
        # Record available rule decks without treating file presence as rule verification.
        for relative in ['drc/FreePDK45.lydrc', 'lvs/FreePDK45.lylvs', 'cdl/NangateOpenCellLibrary.cdl']:
            path = platform / relative
            if path.is_file():
                path.resolve().relative_to(platform)
                report['files'].append(file_record(path, 'optional_physical_material'))
        bins = [root / 'tools/install/OpenROAD/bin', root / 'tools/install/yosys/bin']
        env = os.environ.copy()
        env['PATH'] = os.pathsep.join(str(p) for p in bins) + os.pathsep + env.get('PATH', '')
        with tempfile.TemporaryDirectory(prefix='backend-library-', dir=output.parent) as scratch:
            env['HOME'] = scratch

            def run(label, argv, marker=None):
                result = subprocess.run(argv, capture_output=True, text=True, env=env, cwd=scratch, timeout=120)
                (output.parent / (label + '.stdout.log')).write_text(result.stdout)
                (output.parent / (label + '.stderr.log')).write_text(result.stderr)
                report['checks'].append({'id': label, 'argv': argv, 'exit_code': result.returncode})
                if result.returncode != 0 or (marker and marker not in result.stdout):
                    raise ValueError(label + ' failed; see original stdout/stderr')
                return result.stdout + result.stderr

            versions = {'openroad': ['-version'], 'yosys': ['-V'], 'klayout': ['-b', '-v'], 'python3': ['--version'], 'make': ['--version']}
            for name, flags in versions.items():
                configured = request['tools'].get(name)
                path = Path(configured or shutil.which(name, path=env['PATH']) or '/nonexistent').resolve(strict=True)
                if not os.access(path, os.X_OK):
                    raise ValueError(name + ' is not executable')
                version = run(name + '-version', [str(path), *flags]).strip()
                if not version:
                    raise ValueError('No version output from ' + name)
                report['tools'][name] = {**file_record(path, 'tool'), 'version': version[:4096]}
            if not re.search(r'GNU Make [4-9]\.', report['tools']['make']['version']):
                raise ValueError('ORFS adapter requires GNU Make >=4; configure tools.make explicitly')
            tool = lambda name: report['tools'][name]['path']
            tcl = Path(scratch) / 'read-platform.tcl'
            tcl.write_text('read_lef ' + tcl_word(roles['technology_lef']) + '\nread_lef ' + tcl_word(roles['cell_lef'])
                           + '\nread_liberty ' + tcl_word(roles['liberty']) + '\nputs "RTL_BACKEND_OPENROAD_READ_OK"\n')
            run('openroad-library-read', [tool('openroad'), '-no_init', '-exit', str(tcl)], 'RTL_BACKEND_OPENROAD_READ_OK')
            liberty = str(roles['liberty']).replace('\\', '\\\\').replace('"', '\\"')
            yosys = run('yosys-liberty-read', [tool('yosys'), '-Q', '-T', '-p', 'read_liberty -lib "' + liberty + '"'])
            if not re.search(r'Imported\s+[1-9][0-9]*\s+cell types', yosys):
                raise ValueError('Yosys did not import any Liberty cells')
            script = Path(scratch) / 'read-gds.py'
            script.write_text('import pya\ncount=0\n' + ''.join('layout=pya.Layout()\nlayout.read(' + repr(str(path)) + ')\ncount+=layout.cells()\n' for path in gds)
                              + 'assert count>0\nprint("RTL_BACKEND_GDS_READ_OK",count)\n')
            run('klayout-gds-read', [tool('klayout'), '-b', '-r', str(script)], 'RTL_BACKEND_GDS_READ_OK')
        report['status'] = 'pass'
    except Exception as error:
        report['error'] = type(error).__name__ + ': ' + str(error)
    report['completed_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    temp = output.with_suffix('.tmp')
    temp.write_text(json.dumps(report, indent=2) + '\n')
    temp.replace(output)
    print(json.dumps({'status': report['status'], 'scope': report['scope'], 'error': report.get('error')}))
    return 0 if report['status'] == 'pass' else 1


if __name__ == '__main__':
    raise SystemExit(main())
