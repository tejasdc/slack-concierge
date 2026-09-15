"""Freeze an explicitly selected source into an owner-private experiment directory."""
import argparse
import json
import os
from pathlib import Path
from normalize import normalize, digest


def reject_archive_destination(path):
    path = Path(path).resolve()
    if any(path.is_relative_to(root) for root in (Path('/root/transcript-archive'),Path('/root/archives'))):
        raise ValueError('Experiment output cannot be inside an archive')
    return path


def private_directory(path):
    path = reject_archive_destination(path)
    if any((parent / '.git').exists() for parent in [path, *path.parents]):
        raise ValueError('Private output must be outside Git worktrees')
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    if path.stat().st_mode & 0o077:
        raise ValueError('Private directory must have mode 0700')
    return path


def prepare(provider, source, destination, leaf=None, conversation_id=None):
    source = Path(source).resolve(strict=True)
    destination = private_directory(destination)
    raw = source.read_bytes()
    projected = normalize(provider, source, leaf, conversation_id)
    if digest(raw) != projected['source_sha256']:
        raise ValueError('Source changed while preparing; select a stable snapshot')
    manifest = {'provider':provider,'source_path':str(source),'source_sha256':digest(raw),'source_bytes':len(raw),
                'source_session_id':projected['source_session_id'],'selected_leaf':projected['selected_leaf'],
                'source_version':projected['source_version']}
    for name, data in [('source.jsonl' if provider!='chatgpt' else 'source.json',raw),
                       ('dialogue.json',json.dumps(projected,indent=2).encode()),
                       ('manifest.json',json.dumps(manifest,indent=2).encode())]:
        with (destination / name).open('xb') as f:
            os.chmod(f.name, 0o600)
            f.write(data)
    return {'case':destination.name,'provider':provider,'source_sha256':digest(raw),
            'messages':len(projected['messages']),'roles':{r:sum(m['role']==r for m in projected['messages']) for r in ['user','assistant']}}


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('provider',choices=['claude','codex','chatgpt'])
    parser.add_argument('source')
    parser.add_argument('destination')
    parser.add_argument('--leaf')
    parser.add_argument('--conversation-id')
    args=parser.parse_args()
    print(json.dumps(prepare(args.provider,args.source,args.destination,args.leaf,args.conversation_id)))
