"""Bounded native subjects in a separate bwrap mount/PID/IPC namespace.

No managed daemon connection; no live home, projects, archives, Slack credentials,
Unix sockets, or agent config are mounted. Only copied native history is supplied.
"""
import argparse
import asyncio
import json
import os
import shutil
import signal
import time
from pathlib import Path
from prepare import private_directory
from normalize import digest


def sandbox(run, extra=()):
    command=['bwrap','--die-with-parent','--unshare-pid','--unshare-ipc','--unshare-uts',
             '--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
             '--symlink','usr/bin','/bin','--symlink','usr/sbin','/sbin',
             '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/etc',
             '--ro-bind','/etc/ssl','/etc/ssl','--ro-bind','/etc/resolv.conf','/etc/resolv.conf',
             '--ro-bind','/etc/hosts','/etc/hosts','--ro-bind','/etc/passwd','/etc/passwd',
             '--ro-bind','/etc/nsswitch.conf','/etc/nsswitch.conf',
             '--bind',str(run/'home'),'/home/reviewer','--bind',str(run/'work'),'/work',
             '--chdir','/work',*extra]
    return command


def env_for(run):
    return {'PATH':'/usr/bin:/bin','HOME':'/home/reviewer','LANG':'C.UTF-8','TERM':'dumb',
            'DISABLE_AUTOUPDATER':'1','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1'}


async def claude(case,run,model,manifest):
    profile=run/'home'/'.claude'
    project=profile/'projects'/'-work'
    project.mkdir(parents=True)
    target=project/(manifest['source_session_id']+'.jsonl')
    shutil.copyfile(case/'source.jsonl',target)
    source_hash=digest(target.read_bytes())
    token=json.loads(Path('/root/.claude/.credentials.json').read_text())['claudeAiOauth']['accessToken']
    env=env_for(run)|{'CLAUDE_CONFIG_DIR':'/home/reviewer/.claude','CLAUDE_CODE_OAUTH_TOKEN':token}
    args=sandbox(run,['--ro-bind',str(target),'/home/reviewer/.claude/projects/-work/'+target.name])
    args+=['--','/usr/bin/claude','-p','--resume',manifest['source_session_id'],'--fork-session',
           '--resume-session-at',manifest['selected_leaf'],'--model',model,'--safe-mode','--restricted',
           '--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
           '--setting-sources','','--permission-mode','dontAsk','--permission-prompts','none',
           '--disable-slash-commands','--no-chrome','--max-turns','1','--max-budget-usd','5',
           '--system-prompt',(case/'system.txt').read_text(),'--system-prompt-snapshot','off',
           '--output-format','stream-json','--verbose']
    stderr=(run/'stderr.log').open('wb')
    proc=await asyncio.create_subprocess_exec(*args,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=stderr,start_new_session=True)
    try:
        stdout,_=await asyncio.wait_for(proc.communicate((case/'question.txt').read_bytes()),240)
    except BaseException:
        os.killpg(proc.pid,signal.SIGKILL)
        await proc.wait()
        raise
    finally: stderr.close()
    (run/'stream.jsonl').write_bytes(stdout)
    records=[]
    for line in stdout.splitlines():
        try: records.append(json.loads(line))
        except ValueError: pass
    init=next((r for r in records if r.get('type')=='system' and r.get('subtype')=='init'),{})
    result=next((r for r in reversed(records) if r.get('type')=='result'),{})
    tool_calls=sum(b.get('type')=='tool_use' for r in records if r.get('type')=='assistant' for b in r.get('message',{}).get('content',[]) if isinstance(b,dict))
    models=sorted({r.get('message',{}).get('model') for r in records if r.get('message',{}).get('model')})
    return {'exit_code':proc.returncode,'provider':'anthropic','requested_model':model,'models':models,'init_model':init.get('model'),
            'tools':init.get('tools'),'mcp_servers':init.get('mcp_servers'),'tool_calls':tool_calls,
            'source_session_id':manifest['source_session_id'],'child_session_id':result.get('session_id',init.get('session_id')),
            'source_copy_unchanged':digest(target.read_bytes())==source_hash,'result':result,
            'text':result.get('result',''),'status':'provider-error' if result.get('is_error') else result.get('subtype','missing-result')}


async def codex(case,run,model,manifest,operation='fork'):
    profile=run/'home'/'.codex'
    profile.mkdir()
    native_relative=Path(*Path(manifest['source_path']).parts[-4:])
    source_copy=profile/'sessions'/native_relative
    source_copy.parent.mkdir(parents=True)
    shutil.copyfile(case/'source.jsonl',source_copy)
    auth=json.loads(Path('/root/.codex/auth.json').read_text())
    # Existing access token only; no copied refresh token can rotate the shared credential.
    auth['tokens']['refresh_token']=''
    (profile/'auth.json').write_text(json.dumps(auth))
    os.chmod(profile/'auth.json',0o600)
    disabled=['apps','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use',
              'code_mode','code_mode_host','code_mode_only','hooks','memories','multi_agent','multi_agent_v2',
              'plugins','remote_plugin','goals','shell_tool','shell_snapshot','shell_snapshot_v2','unified_exec',
              'image_generation','view_image','sleep_tool','skill_search','skill_mcp_dependency_install','workspace_dependencies']
    config='model = '+json.dumps(model)+'\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\ncheck_for_update_on_startup = false\n[features]\n'+''.join(f'{f} = false\n' for f in disabled)
    (profile/'config.toml').write_text(config)
    binary=Path(shutil.which('codex')).resolve()
    source_mount=['--ro-bind',str(source_copy),'/home/reviewer/.codex/sessions/'+str(native_relative)] if operation=='fork' else []
    args=sandbox(run,['--dir','/opt','--ro-bind',str(binary),'/opt/codex',*source_mount])
    args+=['--','/opt/codex','app-server','--stdio']
    env=env_for(run)|{'CODEX_HOME':'/home/reviewer/.codex'}
    stderr=(run/'stderr.log').open('wb')
    proc=await asyncio.create_subprocess_exec(*args,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=stderr,start_new_session=True,limit=4000000)
    stream=(run/'stream.jsonl').open('w')
    counter=0
    pending={}
    notifications=[]
    final=asyncio.get_running_loop().create_future()
    async def send(message):
        proc.stdin.write((json.dumps(message)+'\n').encode())
        await proc.stdin.drain()
    async def reader():
        while line:=await proc.stdout.readline():
            stream.write(line.decode());stream.flush()
            message=json.loads(line)
            if 'id' in message and ('result' in message or 'error' in message):
                future=pending.pop(message['id'],None)
                if future is not None:
                    if 'error' in message: future.set_exception(RuntimeError(json.dumps(message['error'])))
                    else: future.set_result(message['result'])
            elif 'id' in message:
                # No server-requested tool or approval is fulfilled, even for old pending tools.
                notifications.append({'blocked_server_request':message.get('method')})
                await send({'id':message['id'],'error':{'code':-32000,'message':'Consultation forbids tools and approvals'}})
            else:
                notifications.append(message)
                if message.get('method')=='turn/completed' and not final.done(): final.set_result(message['params'])
        for future in pending.values():
            if not future.done(): future.set_exception(RuntimeError('App server exited before response'))
    read_task=asyncio.create_task(reader())
    async def request(method,params):
        nonlocal counter
        counter+=1
        future=asyncio.get_running_loop().create_future();pending[counter]=future
        await send({'id':counter,'method':method,'params':params})
        return await asyncio.wait_for(future,45)
    try:
        init=await request('initialize',{'clientInfo':{'name':'historical-consultation-experiment','version':'1'},
            'capabilities':{'experimentalApi':True,'requestAttestation':False}})
        await send({'method':'initialized'})
        source=await request('thread/read',{'threadId':manifest['source_session_id'],'includeTurns':True})
        (run/'source-read.json').write_text(json.dumps(source,indent=2))
        source_turns=source['thread'].get('turns',[])
        cutoff=source_turns[-1]['id'] if source_turns and source_turns[-1].get('status')=='completed' else None
        if cutoff is None:
            # Older archives can load without a native turn catalogue. The subject may
            # still accept the frozen full history; measure its answer rather than claim continuity.
            records=[json.loads(line) for line in (case/'source.jsonl').read_bytes().splitlines() if line.strip()]
            if records[-1].get('payload',{}).get('type')!='task_complete':
                raise ValueError('No native cutoff and frozen archive does not end in task_complete')
        native_params={'threadId':manifest['source_session_id'],
            'model':model,'cwd':'/work','runtimeWorkspaceRoots':['/work'],'approvalPolicy':'never','sandbox':'read-only',
            'baseInstructions':(case/'system.txt').read_text(),'developerInstructions':(case/'system.txt').read_text()}
        if operation=='fork':
            native_params.update({'deferGoalContinuation':True,'excludeTurns':False,**({'lastTurnId':cutoff} if cutoff else {})})
        fork=await request('thread/fork' if operation=='fork' else 'thread/resume',native_params)
        (run/'fork.json').write_text(json.dumps(fork,indent=2))
        thread=fork['thread']['id']
        # The entire isolated runtime has goals disabled, so goal methods reject.
        # Keep them disabled for this child's whole lifetime; do not enable an old goal.
        goal={'feature_enabled':False,'initial_continuation_deferred':True}
        turn=await request('turn/start',{'threadId':thread,'input':[{'type':'text','text':(case/'question.txt').read_text()}],
            'model':model,'effort':'medium','cwd':'/work','runtimeWorkspaceRoots':['/work'],'approvalPolicy':'never',
            'sandboxPolicy':{'type':'readOnly'},'environments':[]})
        completed=await asyncio.wait_for(final,240)
        items=[n['params']['item'] for n in notifications if n.get('method')=='item/completed']
        texts=[i.get('text','') for i in items if i.get('type')=='agentMessage']
        tool_items=[i.get('type') for i in items if i.get('type') not in ('userMessage','agentMessage','reasoning')]
        return {'provider':'openai','operation':operation,'requested_model':model,'init':init,'fork_model':fork.get('model'),
                'source_session_id':manifest['source_session_id'],'child_session_id':thread,'native_turns':len(fork['thread'].get('turns',[])),
                'native_cutoff':cutoff,'source_copy_unchanged':digest(source_copy.read_bytes())==manifest['source_sha256'],
                'source_native_turns':len(source_turns),'boundary_mode':'native-completed-turn' if cutoff else 'frozen-complete-rollout',
                'goal_before_turn':goal,'turn':turn,'completed':completed,'tool_items':tool_items,
                'blocked_server_requests':[n for n in notifications if 'blocked_server_request' in n],
                'text':'\n\n'.join(texts),'status':completed['turn']['status']}
    finally:
        if proc.returncode is None:
            os.killpg(proc.pid,signal.SIGTERM)
            try: await asyncio.wait_for(proc.wait(),5)
            except asyncio.TimeoutError: os.killpg(proc.pid,signal.SIGKILL);await proc.wait()
        await read_task
        stream.close();stderr.close()


async def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('case');parser.add_argument('run_name');parser.add_argument('--model',required=True)
    parser.add_argument('--operation',choices=['fork','resume-copy'],default='fork')
    args=parser.parse_args()
    if args.run_name in ('.','..') or Path(args.run_name).name!=args.run_name:
        raise ValueError('Run name must be a single new directory name')
    case=private_directory(args.case)
    run=case/args.run_name
    run.mkdir(mode=0o700)
    (run/'home').mkdir();(run/'work').mkdir()
    manifest=json.loads((case/'manifest.json').read_text())
    start=time.monotonic()
    try:
        if manifest['provider']=='claude': result=await claude(case,run,args.model,manifest)
        elif manifest['provider']=='codex': result=await codex(case,run,args.model,manifest,args.operation)
        else: raise ValueError('No native ChatGPT export adapter')
    except Exception as e: result={'status':'error','error':str(e),'requested_model':args.model}
    finally:
        if manifest['provider']=='codex':
            (run/'home'/'.codex'/'auth.json').unlink(missing_ok=True)
    result['duration_seconds']=round(time.monotonic()-start,2)
    result['snapshot_unchanged']=digest((case/'source.jsonl').read_bytes())==manifest['source_sha256']
    result['archive_source_unchanged']=digest(Path(manifest['source_path']).read_bytes())==manifest['source_sha256']
    if result.get('child_session_id'):
        result['native_identity_changed']=result['child_session_id']!=manifest['source_session_id']
    (run/'result.json').write_text(json.dumps(result,indent=2))
    print(json.dumps({k:result.get(k) for k in ['status','requested_model','models','fork_model','tool_calls','tool_items','duration_seconds','snapshot_unchanged','archive_source_unchanged']}))
    if result['status'] not in ('success','completed'): raise SystemExit(1)


if __name__=='__main__': asyncio.run(main())
