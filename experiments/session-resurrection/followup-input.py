"""Append the observed answer and a new question to a serialized Pi context."""
import argparse
import json
from pathlib import Path
from prepare import private_directory

parser=argparse.ArgumentParser()
parser.add_argument('prior_input');parser.add_argument('prior_result');parser.add_argument('question_file');parser.add_argument('output')
args=parser.parse_args()
output=Path(args.output);private_directory(output.parent)
request=json.loads(Path(args.prior_input).read_text())
result=json.loads(Path(args.prior_result).read_text())
if result.get('stop_reason')!='stop' or result.get('tool_calls'):
    raise ValueError('Only a completed tool-free answer may be appended')
request['messages'] += [{'role':'assistant','content':result['text']},{'role':'user','content':Path(args.question_file).read_text()}]
with output.open('x') as f: json.dump(request,f,indent=2)
print(json.dumps({'messages':len(request['messages']),'model':request['model']}))
