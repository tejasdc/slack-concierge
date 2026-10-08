#!/usr/bin/env python3
"""Where Claude and Codex tokens went in a time window, from real transcripts.

Claude: every assistant row carries message.usage; rows of one API call share
message.id, so each call is counted once. A "turn" starts at a user row that is
not a tool result. Codex: token_count events carry last_token_usage per call.
"""
import glob, json, os, sys, time
from collections import defaultdict
from datetime import datetime, timezone

hours = float(sys.argv[1]) if len(sys.argv) > 1 else 24
since = time.time() - hours * 3600
out_json = sys.argv[2] if len(sys.argv) > 2 else None

def ts(s):
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
    except Exception:
        return None

claude = {}
for path in glob.glob('/root/.claude/projects/*/*.jsonl') + glob.glob('/root/.claude/projects/*/*/subagents/*.jsonl'):
    try:
        if os.path.getmtime(path) < since:
            continue
    except OSError:
        continue
    sid = os.path.basename(path)[:-6]
    s = claude.setdefault(path, dict(path=path, sid=sid, cwd=None, calls=0, fresh=0, cw=0, cw1h=0, cr=0, out=0,
                                     turns=0, max_ctx=0, gaps_over_5m=0, gap_rewrite=0, per_turn=[], model=None))
    seen = set()
    cur_turn_calls = 0
    last_call_t = None
    with open(path, errors='replace') as f:
        for line in f:
            try:
                r = json.loads(line)
            except Exception:
                continue
            t = ts(r.get('timestamp', '') or '')
            if r.get('cwd'):
                s['cwd'] = r['cwd']
            if r.get('type') == 'user' and t and t >= since:
                c = (r.get('message') or {}).get('content')
                is_tool = isinstance(c, list) and any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c)
                if not is_tool and not r.get('isMeta'):
                    if cur_turn_calls:
                        s['per_turn'].append(cur_turn_calls)
                    cur_turn_calls = 0
                    s['turns'] += 1
            if r.get('type') != 'assistant' or not t or t < since:
                continue
            m = r.get('message') or {}
            u = m.get('usage')
            mid = m.get('id') or r.get('requestId')
            if not u or mid in seen:
                continue
            seen.add(mid)
            if m.get('model') == '<synthetic>':
                continue
            s['model'] = m.get('model')
            cc = u.get('cache_creation') or {}
            w1h = cc.get('ephemeral_1h_input_tokens', 0) or 0
            cw = u.get('cache_creation_input_tokens', 0) or 0
            cr = u.get('cache_read_input_tokens', 0) or 0
            s['calls'] += 1
            cur_turn_calls += 1
            s['fresh'] += u.get('input_tokens', 0) or 0
            s['cw'] += cw
            s['cw1h'] += w1h
            s['cr'] += cr
            s['out'] += u.get('output_tokens', 0) or 0
            ctx = cw + cr + (u.get('input_tokens', 0) or 0)
            s['max_ctx'] = max(s['max_ctx'], ctx)
            if last_call_t and t - last_call_t > 300:
                s['gaps_over_5m'] += 1
                s['gap_rewrite'] += cw
            last_call_t = t
    if cur_turn_calls:
        s['per_turn'].append(cur_turn_calls)

claude = {k: v for k, v in claude.items() if v['calls']}

codex = {}
for path in glob.glob('/root/.codex/sessions/2026/*/*/*.jsonl') + glob.glob('/root/.codex-accounts/*/sessions/2026/*/*/*.jsonl'):
    try:
        if os.path.getmtime(path) < since:
            continue
    except OSError:
        continue
    s = dict(path=path, cwd=None, calls=0, fresh=0, cr=0, out=0, turns=0, max_ctx=0, per_turn=[])
    cur = 0
    with open(path, errors='replace') as f:
        for line in f:
            try:
                r = json.loads(line)
            except Exception:
                continue
            t = ts(r.get('timestamp', '') or '')
            p = r.get('payload') or {}
            if r.get('type') == 'session_meta':
                s['cwd'] = p.get('cwd')
            if r.get('type') == 'turn_context' and p.get('cwd'):
                s['cwd'] = p.get('cwd')
            if not t or t < since:
                continue
            if r.get('type') == 'event_msg' and p.get('type') == 'task_started':
                if cur:
                    s['per_turn'].append(cur)
                cur = 0
                s['turns'] += 1
            if r.get('type') == 'event_msg' and p.get('type') == 'token_count':
                info = p.get('info') or {}
                lu = info.get('last_token_usage')
                if not lu:
                    continue
                inp = lu.get('input_tokens', 0) or 0
                cached = lu.get('cached_input_tokens', 0) or 0
                s['calls'] += 1
                cur += 1
                s['cr'] += cached
                s['fresh'] += inp - cached
                s['out'] += lu.get('output_tokens', 0) or 0
                s['max_ctx'] = max(s['max_ctx'], inp)
    if cur:
        s['per_turn'].append(cur)
    if s['calls']:
        codex[path] = s

def M(n):
    return f'{n/1e6:8.1f}M'

def summarize(name, rows, has_cw):
    tot = defaultdict(int)
    for r in rows:
        for k in ('calls', 'fresh', 'cw', 'cw1h', 'cr', 'out', 'turns', 'gap_rewrite', 'gaps_over_5m'):
            tot[k] += r.get(k, 0)
    print(f'\n== {name}: {len(rows)} transcripts, {tot["calls"]} model calls, {tot["turns"]} turns')
    print(f'fresh input {M(tot["fresh"])}  cache-write {M(tot["cw"])} (1h {M(tot["cw1h"])})  cache-read {M(tot["cr"])}  output {M(tot["out"])}')
    if has_cw:
        # API price weights relative to fresh input: read 0.1, 5m write 1.25, 1h write 2, output 5
        w = dict(fresh=tot['fresh'], cw=1.25 * (tot['cw'] - tot['cw1h']) + 2 * tot['cw1h'], cr=0.1 * tot['cr'], out=5 * tot['out'])
        allw = sum(w.values()) or 1
        print('API-price-weighted share: ' + '  '.join(f'{k} {100*v/allw:.0f}%' for k, v in w.items()))
        print(f'cache re-writes after >5min idle gaps: {tot["gaps_over_5m"]} gaps, {M(tot["gap_rewrite"])} written')
    return tot

def weight(r):
    return r['fresh'] + 1.25 * (r.get('cw', 0) - r.get('cw1h', 0)) + 2 * r.get('cw1h', 0) + 0.1 * r['cr'] + 5 * r['out']

for name, rows, has_cw in (('Claude', list(claude.values()), True), ('Codex', list(codex.values()), False)):
    summarize(name, rows, has_cw)
    rows.sort(key=weight, reverse=True)
    print(f'{"weighted":>9} {"cr":>8} {"cw":>8} {"out":>7} {"calls":>6} {"turns":>5} {"call/turn":>9} {"maxctx":>7} cwd / id')
    for r in rows[:25]:
        pt = r['per_turn']
        cpt = (sum(pt) / len(pt)) if pt else 0
        print(f'{weight(r)/1e6:8.1f}M {r["cr"]/1e6:7.1f}M {r.get("cw",0)/1e6:7.1f}M {r["out"]/1e6:6.2f}M {r["calls"]:6d} {r["turns"]:5d} {cpt:9.1f} {r["max_ctx"]/1e3:6.0f}k {(r["cwd"] or "?").replace("/root/workspace/","")} {os.path.basename(r["path"])[:44]}')

if out_json:
    json.dump(dict(claude=list(claude.values()), codex=list(codex.values())), open(out_json, 'w'))
