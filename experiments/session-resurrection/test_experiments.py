import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import asyncio
import contextlib
import copy
import io
import sys
from unittest.mock import patch
from pathlib import Path

from normalize import normalize
from prepare import prepare, private_directory
from native import sandbox, env_for
import native
from normalize import digest
from summarize import validated_grade, safe_omissions


class ProjectionTests(unittest.TestCase):
    def setUp(self):
        # This host has an unrelated Git repository at /tmp; output guards rightly reject it.
        self.temp=tempfile.TemporaryDirectory(dir='/var/tmp')
        self.root=Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def jsonl(self, records):
        path=self.root/'source.jsonl'
        path.write_text('\n'.join(json.dumps(r) for r in records)+'\n')
        return path
    def claude(self, uuid, parent, role, text):
        return {'type':role,'uuid':uuid,'parentUuid':parent,'sessionId':'source',
                'message':{'role':role,'content':[{'type':'text','text':text}]}}

    def test_claude_branch_excludes_sibling_and_keeps_order(self):
        source=self.jsonl([self.claude('u',None,'user','Choose blue'),self.claude('a','u','assistant','Blue selected'),
                           self.claude('b','u','assistant','Red branch')])
        result=normalize('claude',source,leaf='a')
        self.assertEqual([m['text'] for m in result['messages']],['Choose blue','Blue selected'])
        self.assertEqual([m['role'] for m in result['messages']],['user','assistant'])

    def test_claude_broken_chain_is_not_silently_flattened(self):
        source=self.jsonl([self.claude('u','missing','user','Constraint')])
        with self.assertRaisesRegex(ValueError,'Broken'): normalize('claude',source)

    def test_claude_compaction_requires_explicit_policy(self):
        source=self.jsonl([{'type':'system','subtype':'compact_boundary'},self.claude('u',None,'user','Tail')])
        with self.assertRaisesRegex(ValueError,'Compacted'): normalize('claude',source)

    def test_claude_tool_records_connect_branch_but_are_not_replayed(self):
        user=self.claude('u',None,'user','Answer briefly')
        tool={'type':'assistant','uuid':'t','parentUuid':'u','message':{'role':'assistant','content':[{'type':'tool_use','name':'Bash','input':{'command':'never run me'}}]}}
        result=normalize('claude',self.jsonl([user,tool,self.claude('a','t','assistant','Answer')]))
        self.assertEqual([m['text'] for m in result['messages']],['Answer briefly','Answer'])
        self.assertEqual(result['omissions']['tool_use'],1)

    def test_codex_event_mirrors_and_tools_are_not_dialogue(self):
        source=self.jsonl([{'type':'session_meta','payload':{'id':'first','cli_version':'test'}},
            {'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':'Real request'}]}},
            {'type':'event_msg','payload':{'type':'user_message','message':'Real request'}},
            {'type':'response_item','payload':{'type':'function_call','name':'exec','arguments':'never execute'}},
            {'type':'response_item','payload':{'type':'message','role':'assistant','content':[{'type':'output_text','text':'Decision'}]}}])
        result=normalize('codex',source)
        self.assertEqual([m['text'] for m in result['messages']],['Real request','Decision'])

    def test_codex_external_history_is_rejected(self):
        source=self.jsonl([{'type':'session_meta','payload':{'id':'a','history_base':{'source':'elsewhere'}}}])
        with self.assertRaisesRegex(ValueError,'dependency'): normalize('codex',source)

    def test_codex_compaction_is_not_silently_expanded(self):
        source=self.jsonl([{'type':'compacted','payload':{'message':'Summary'}}])
        with self.assertRaisesRegex(ValueError,'Compacted'): normalize('codex',source)

    def test_codex_first_session_metadata_is_canonical(self):
        source=self.jsonl([{'type':'session_meta','payload':{'id':'first'}},{'type':'session_meta','payload':{'id':'later'}}])
        self.assertEqual(normalize('codex',source)['source_session_id'],'first')

    def chatgpt_fixture(self):
        def node(parent,role,content,**extra):
            return {'parent':parent,'message':{'author':{'role':role},'content':content,**extra}}
        return {'id':'chat','current_node':'chosen','mapping':{
            'root':{'parent':None,'message':None},
            'context':node('root','user',{'content_type':'user_editable_context','user_profile':'Private profile','user_instructions':'Old preference'}),
            'u':node('context','user',{'content_type':'multimodal_text','parts':['Inspect this diagram',{'content_type':'image_asset_pointer','asset_pointer':'file-service://image'}]},metadata={'attachments':[{'id':'image'}]}),
            'chosen':node('u','assistant',{'content_type':'text','parts':['Chosen conclusion']}),
            'sibling':node('u','assistant',{'content_type':'text','parts':['Wrong branch']})}}

    def test_chatgpt_selects_explicit_conversation_and_current_branch(self):
        path=self.root/'export.json';path.write_text(json.dumps([self.chatgpt_fixture()]))
        with self.assertRaisesRegex(ValueError,'exact conversation'): normalize('chatgpt',path)
        result=normalize('chatgpt',path,conversation_id='chat')
        self.assertEqual([m['text'] for m in result['messages']],['Inspect this diagram','Chosen conclusion'])
        self.assertEqual(result['omissions']['multimodal_non_text_part'],1)
        self.assertEqual(result['omissions']['attachment_reference'],1)
        self.assertEqual(result['omissions']['user_editable_context'],1)

    def test_chatgpt_branch_override_and_cycle_detection(self):
        data=self.chatgpt_fixture();path=self.root/'export.json';path.write_text(json.dumps(data))
        self.assertEqual(normalize('chatgpt',path,leaf='sibling')['messages'][-1]['text'],'Wrong branch')
        data['mapping']['u']['parent']='chosen';path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError,'cyclic'): normalize('chatgpt',path)

    def test_chatgpt_keeps_embedded_spoken_text_without_claiming_audio(self):
        data=self.chatgpt_fixture()
        data['mapping']['u']['message']['content']['parts']=[{'content_type':'audio_transcription','text':'My spoken requirement'},
            {'content_type':'audio_asset_pointer','asset_pointer':'file-service://audio'}]
        path=self.root/'export.json';path.write_text(json.dumps(data))
        result=normalize('chatgpt',path)
        self.assertEqual(result['messages'][0]['text'],'My spoken requirement')
        self.assertEqual(result['omissions']['multimodal_non_text_part'],1)

    def test_chatgpt_keeps_visible_commentary_but_omits_hidden_text(self):
        data=self.chatgpt_fixture();data['mapping']['chosen']['message']['channel']='commentary'
        path=self.root/'export.json';path.write_text(json.dumps(data))
        self.assertEqual(normalize('chatgpt',path)['messages'][-1]['text'],'Chosen conclusion')
        data['mapping']['chosen']['message']['metadata']={'is_visually_hidden_from_conversation':True}
        path.write_text(json.dumps(data))
        self.assertEqual(len(normalize('chatgpt',path)['messages']),1)

    def test_snapshot_leaves_source_bytes_unchanged_and_refuses_overwrite(self):
        source=self.jsonl([self.claude('u',None,'user','Requirement')]);before=source.read_bytes()
        dest=self.root/'private';prepare('claude',source,dest)
        self.assertEqual(source.read_bytes(),before)
        self.assertEqual((dest/'source.jsonl').read_bytes(),before)
        self.assertEqual(dest.stat().st_mode & 0o777,0o700)
        with self.assertRaises(FileExistsError): prepare('claude',source,dest)

    def test_private_output_cannot_be_in_git_or_world_readable(self):
        repo=self.root/'repo';repo.mkdir();(repo/'.git').mkdir()
        with self.assertRaisesRegex(ValueError,'Git'): private_directory(repo/'data')
        loose=self.root/'loose';loose.mkdir(mode=0o755)
        with self.assertRaisesRegex(ValueError,'0700'): private_directory(loose)

    def test_both_archive_roots_are_rejected_before_mkdir_including_symlinks(self):
        for source_root in ['/root/transcript-archive','/root/archives/chatgpt-export-2025-11-21']:
            with patch.object(Path,'mkdir') as mkdir:
                with self.assertRaisesRegex(ValueError,'archive'): private_directory(Path(source_root)/'new-case')
                mkdir.assert_not_called()
        link=self.root/'archive-link';link.symlink_to('/root/archives/chatgpt-export-2025-11-21')
        with self.assertRaisesRegex(ValueError,'archive'): private_directory(link/'new-case')

    @unittest.skipUnless(shutil.which('node'),'Node required')
    def test_pi_archive_output_is_rejected_before_auth_or_provider_input(self):
        script=Path(__file__).parent/'pi-call.mjs'
        for source_root in ['/root/transcript-archive','/root/archives/chatgpt-export-2025-11-21']:
            if not Path(source_root).exists(): continue
            target=Path(source_root)/'synthetic-experiment-guard-never-created.json'
            self.assertFalse(target.exists())
            result=subprocess.run(['node',str(script),'/nonexistent-input',str(target),'/nonexistent-auth'],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('Experiment output cannot be inside an archive',result.stderr)
            self.assertFalse(target.exists())

    def test_public_grade_rejects_private_canaries_and_invalid_fact_identities(self):
        rubric={'facts':[{'id':f'F{i}'} for i in range(1,7)]}
        good={'facts':[{'id':f'F{i}','score':1,'answer_quote':'synthetic evidence'} for i in range(1,7)],
              'unknown_handled':True,'citation_quality':'supported'}
        self.assertEqual(validated_grade(good,rubric,'synthetic evidence'),good)
        for field in ['unknown_handled','citation_quality']:
            bad=copy.deepcopy(good);bad[field]='SYNTHETIC_PRIVATE_CANARY'
            with self.assertRaises(ValueError) as error: validated_grade(bad,rubric,'synthetic evidence')
            self.assertNotIn('SYNTHETIC_PRIVATE_CANARY',str(error.exception))
        bad=copy.deepcopy(good);bad['facts'][-1]['id']='F1'
        with self.assertRaisesRegex(ValueError,'identities'): validated_grade(bad,rubric,'synthetic evidence')
        bad=copy.deepcopy(good);bad['facts'][0]['score']='SYNTHETIC_PRIVATE_CANARY'
        with self.assertRaises(ValueError): validated_grade(bad,rubric,'synthetic evidence')

    def test_public_omission_keys_do_not_export_private_strings(self):
        self.assertEqual(safe_omissions({'SYNTHETIC_PRIVATE_CANARY':3,'thinking':2}),{'other_omitted_records':3,'thinking':2})

    def test_refused_grading_regeneration_keeps_existing_labels_and_input(self):
        case=self.root/'case';case.mkdir(mode=0o700)
        labels=case/'grade-labels.json';labels.write_text('{"C":"baseline"}')
        packet=case/'grade-input.json';packet.write_text('{"existing":"immutable"}')
        before={p.name:p.read_bytes() for p in case.iterdir()}
        result=subprocess.run([sys.executable,str(Path(__file__).parent/'grade-input.py'),str(case),'--native-result','/not-read'],capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Grading evidence exists',result.stderr)
        self.assertEqual({p.name:p.read_bytes() for p in case.iterdir()},before)

    def test_failed_native_start_removes_ephemeral_auth_copy(self):
        case=self.root/'case';case.mkdir(mode=0o700)
        raw=b'{"synthetic":"source"}\n';(case/'source.jsonl').write_bytes(raw)
        (case/'manifest.json').write_text(json.dumps({'provider':'codex','source_sha256':digest(raw),'source_path':str(case/'source.jsonl')}))
        async def failure(case_path,run,*args):
            profile=run/'home'/'.codex';profile.mkdir()
            (profile/'auth.json').write_text('{"synthetic":"temporary"}')
            raise RuntimeError('Synthetic pre-launch failure')
        with patch.object(native,'codex',failure),patch.object(sys,'argv',['native.py',str(case),'failed','--model','gpt-6-astra']),contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit): asyncio.run(native.main())
        self.assertFalse((case/'failed/home/.codex/auth.json').exists())
        self.assertEqual((case/'source.jsonl').read_bytes(),raw)

    @unittest.skipUnless(shutil.which('bwrap'),'Linux bwrap required')
    def test_native_subject_has_no_live_root_and_cannot_write_system_paths(self):
        run=self.root/'run';run.mkdir();(run/'home').mkdir();(run/'work').mkdir()
        canary=self.root/'host-canary';canary.write_text('unchanged')
        program=('import pathlib,os; assert not pathlib.Path("/root").exists(); '
                 'assert not pathlib.Path("/var/lib").exists(); '
                 'assert not any("SLACK" in k or "CONCIERGE" in k for k in os.environ); '
                 'pathlib.Path("/work/allowed").write_text("private")\n'
                 'try: pathlib.Path("/usr/forbidden").write_text("blocked")\n'
                 'except OSError: pass\nelse: raise AssertionError("system path writable")')
        subprocess.run(sandbox(run)+['--','/usr/bin/python3','-c',program],env=env_for(run),check=True,capture_output=True)
        self.assertEqual(canary.read_text(),'unchanged')
        self.assertEqual((run/'work'/'allowed').read_text(),'private')


if __name__=='__main__': unittest.main()
