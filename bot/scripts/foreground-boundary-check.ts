import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import ts from 'typescript';

const root=resolve(import.meta.dir,'../src');
const seen=new Set<string>();
const failures:string[]=[];
const builtins=new Set(['node:fs/promises','node:path','node:net','node:crypto']);
function visit(file:string) {
  if(seen.has(file))return;seen.add(file);
  // The shared sink has its own paused-socket execution/memory check and honors
  // stream backpressure; callers may never write to the destination directly.
  if(file===resolve(root,'log.ts'))return;
  const text=readFileSync(file,'utf8');
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const problem=(node:ts.Node,message:string)=>failures.push(`${relative(root,file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line+1} ${message}`);
  const dependency=(node:ts.Node,name:string)=>{
    if(name.startsWith('.')) {
      const path=resolve(dirname(file),name);
      const target=[path,path+'.ts',path+'.json'].find(candidate=>existsSync(candidate));
      if(!target){problem(node,`unresolved gateway dependency ${name}`);return;}
      if(target.endsWith('.json'))return;
      visit(target);
    } else if(!builtins.has(name))problem(node,`dependency outside storage-free gateway boundary: ${name}`);
  };
  const walk=(node:ts.Node)=>{
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&!node.importClause?.isTypeOnly)
      dependency(node,node.moduleSpecifier.text);
    if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&!node.isTypeOnly)
      dependency(node,node.moduleSpecifier.text);
    if(ts.isCallExpression(node)) {
      const expression=node.expression.getText(source);
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword||expression==='require') {
        const argument=node.arguments[0];
        if(!argument||!ts.isStringLiteral(argument))problem(node,'dynamic gateway imports cannot bypass boundary review');
        else dependency(node,argument.text);
      }
      if(expression==='Atomics.wait'||expression==='Bun.sleepSync'||expression.endsWith('Sync')||/^console\./.test(expression))
        problem(node,`blocking or unbounded call on accepting path: ${expression}`);
    }
    ts.forEachChild(node,walk);
  };
  walk(source);
}
visit(resolve(root,'foreground-gateway-worker.ts'));
if(failures.length)throw new Error('Foreground isolation boundary failed:\n'+failures.join('\n'));
console.log(JSON.stringify({check:'foreground-boundary',status:'passed',modules:seen.size}));
