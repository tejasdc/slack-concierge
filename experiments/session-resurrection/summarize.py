"""Emit only the approved non-content experiment evidence fields."""
import argparse
import json
import re
from pathlib import Path
from normalize import digest
from prepare import reject_archive_destination


def validated_grade(grade, rubric, answer):
    expected={f'F{i}' for i in range(1,7)}
    if len(rubric['facts'])!=6 or {f['id'] for f in rubric['facts']}!=expected:
        raise ValueError('Invalid rubric fact identities')
    if len(grade['facts'])!=6 or {f['id'] for f in grade['facts']}!=expected:
        raise ValueError('Invalid graded fact identities')
    if type(grade['unknown_handled']) is not bool:
        raise ValueError('Invalid unknown-answer boolean')
    if grade['citation_quality'] not in ('supported','partial','absent','invented'):
        raise ValueError('Invalid citation-quality enum')
    for fact in grade['facts']:
        if type(fact['score']) not in (int,float) or fact['score'] not in (0,0.5,1):
            raise ValueError('Invalid fact score')
        if fact['score'] and (not isinstance(fact['answer_quote'],str) or not fact['answer_quote'] or fact['answer_quote'] not in answer):
            raise ValueError('Unverified answer quote')
    return grade


def safe_omissions(omissions):
    known={'non_dialogue_record','thinking','tool_use','tool_result','session_meta','event_msg','response_item',
           'turn_context','provider_scaffolding','hidden_or_context_message','multimodal_non_text_part',
           'attachment_reference','thoughts','code','non_dialogue_role','reasoning_recap','user_editable_context',
           'image','input_image','output_image','redacted_thinking','non_text_part'}
    result={}
    for key,count in omissions.items():
        if type(count) is not int or count<0: raise ValueError('Invalid omission count')
        public_key=key if key in known else 'other_omitted_records'
        result[public_key]=result.get(public_key,0)+count
    return result


def parse_text_result(path):
    value=json.loads(Path(path).read_text())['text'].strip()
    return json.loads(value.removeprefix('```json').removesuffix('```').strip())


def summarize(root):
    cases=[]
    for case_id,native_run in [('C1','native-sonnet-v2'),('X1','native-resume-copy-v1'),('G1',None)]:
        case=root/case_id
        manifest=json.loads((case/'manifest.json').read_text())
        if manifest['provider'] not in ('claude','codex','chatgpt'): raise ValueError('Invalid source provider')
        if manifest['source_version'] is not None and not re.fullmatch(r'\d+\.\d+\.\d+',manifest['source_version']): raise ValueError('Invalid source version')
        if not re.fullmatch(r'[0-9a-f]{64}',manifest['source_sha256']): raise ValueError('Invalid source hash')
        if type(manifest['source_bytes']) is not int or manifest['source_bytes']<0: raise ValueError('Invalid source size')
        dialogue=json.loads((case/'dialogue.json').read_text())
        rubric=json.loads((case/'rubric.json').read_text())
        by_ref={m['ref']:m for m in dialogue['messages']}
        assert all(f['quote'] and f['quote'] in by_ref[f['source_ref']]['text'] for f in rubric['facts'])
        labels=json.loads((case/'grade-labels.json').read_text())
        grading=parse_text_result(case/'grade-output.json')
        if any(not isinstance(a.get('label'),str) or a['label'] not in labels for a in grading['answers']):
            raise ValueError('Invalid grading label')
        if len(grading['answers'])!=len(labels) or len({a['label'] for a in grading['answers']})!=len(labels):
            raise ValueError('Duplicate or missing grading labels')
        grades={labels[a['label']]:a for a in grading['answers']}
        row={'case':case_id,'provider':manifest['provider'],'source_version':manifest['source_version'],
             'source_sha256':manifest['source_sha256'],'source_identity_sha256':digest(manifest['source_session_id'].encode()),
             'selected_leaf_sha256':digest((manifest['selected_leaf'] or '').encode()),'source_bytes':manifest['source_bytes'],
             'dialogue_messages':len(dialogue['messages']),'dialogue_roles':{r:sum(m['role']==r for m in dialogue['messages']) for r in ['user','assistant']},
             'omissions':safe_omissions(dialogue['omissions']),'rubric_sha256':digest((case/'rubric.json').read_bytes()),
             'rubric_quotes_verified':len(rubric['facts']),'source_still_matches':digest(Path(manifest['source_path']).read_bytes())==manifest['source_sha256'],
             'results':[]}
        for mode in ['structured','baseline','no-history']:
            result=json.loads((case/(mode+'-result.json')).read_text());grade=grades[mode]
            validated_grade(grade,rubric,result['text'])
            if result['requested_model']!='gpt-6-astra' or result['model']!='gpt-6-astra' or result['provider']!='openai-codex': raise ValueError('Unexpected comparison model identity')
            if result['stop_reason']!='stop' or result['tool_calls']!=0 or result['payload_evidence']['tool_count']!=0: raise ValueError('Unsuccessful or tool-bearing comparison')
            for value in [result['usage']['input'],result['usage']['output'],result['duration_ms']]:
                if type(value) not in (int,float) or value<0: raise ValueError('Invalid comparison metric')
            row['results'].append({'mode':mode,'requested_model':result['requested_model'],'sdk_reported_model':result['model'],
                'provider':result['provider'],'status':result['stop_reason'],'tool_calls':result['tool_calls'],
                'request_tool_count':result['payload_evidence']['tool_count'],'request_role_counts':{r:result['payload_evidence']['roles'].count(r) for r in ['user','assistant']},
                'input_tokens':result['usage']['input'],'output_tokens':result['usage']['output'],'duration_ms':result['duration_ms'],
                'facts':{f['id']:f['score'] for f in grade['facts']},'score':sum(f['score'] for f in grade['facts']),
                'unknown_handled':grade['unknown_handled'],'citation_quality':grade['citation_quality'],
                'answer_sha256':digest(result['text'].encode()),'result_file_sha256':digest((case/(mode+'-result.json')).read_bytes())})
        if native_run:
            result=json.loads((case/native_run/'result.json').read_text());grade=parse_text_result(case/'native-audit-output.json')
            validated_grade(grade,rubric,result['text'])
            expected_model='claude-sonnet-5' if case_id=='C1' else 'gpt-6-astra'
            if result['requested_model']!=expected_model or (result.get('models') or [result.get('fork_model')])!=[expected_model]: raise ValueError('Unexpected native model identity')
            if result['status'] not in ('success','completed'): raise ValueError('Unsuccessful native result')
            if result.get('tools') not in (None,[]) or result.get('tool_calls',0)!=0 or result.get('tool_items',[]): raise ValueError('Unexpected native tool data')
            if type(result['duration_seconds']) not in (int,float) or result['duration_seconds']<0: raise ValueError('Invalid native metric')
            for field in ['snapshot_unchanged','archive_source_unchanged']:
                if type(result[field]) is not bool: raise ValueError('Invalid preservation boolean')
            row['results'].append({'mode':'native-child' if case_id=='C1' else 'native-isolated-copy-resume',
                'requested_model':result['requested_model'],'provider_reported_model':result.get('models') or result.get('fork_model'),
                'native_identity_changed':result['child_session_id']!=result['source_session_id'],'status':result['status'],
                'tool_calls':result.get('tool_calls',len(result.get('tool_items',[]))),
                'tools_exposed':result.get('tools'),'blocked_server_requests':len(result.get('blocked_server_requests',[])),
                'duration_seconds':result['duration_seconds'],'snapshot_unchanged':result['snapshot_unchanged'],
                'archive_source_unchanged':result['archive_source_unchanged'],
                'facts':{f['id']:f['score'] for f in grade['facts']},'score':sum(f['score'] for f in grade['facts']),
                'unknown_handled':grade['unknown_handled'],'citation_quality':grade['citation_quality'],
                'answer_sha256':digest(result['text'].encode()),'result_file_sha256':digest((case/native_run/'result.json').read_bytes())})
        cases.append(row)
    return {'schema_version':1,'scope':'Private, selected historical consultations; no product integration',
            'subjects':{'codex_cli':'0.153.4','claude_cli':'2.1.263','pi_ai':'0.85.1'},
            'source_input':{'channel_id':'C0BNN5K4JSJ','message_ts':'1789440782.455029'},
            'grading':'Six preregistered source-quoted facts per case; Astra model grading with exact evidence quote validation. Native claims audited against native tool evidence. Exploratory, not a model ranking.',
            'cases':cases}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('private_root');parser.add_argument('output')
    args=parser.parse_args()
    evidence=summarize(Path(args.private_root))
    with reject_archive_destination(args.output).open('x') as f: json.dump(evidence,f,indent=2);f.write('\n')
    print(json.dumps({'cases':len(evidence['cases']),'all_sources_unchanged':all(c['source_still_matches'] for c in evidence['cases'])}))
