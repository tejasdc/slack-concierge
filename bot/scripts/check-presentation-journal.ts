import {Database} from 'bun:sqlite';
import {initializePresentationChanges,PRESENTATION_CHANGE_TABLES,presentationChanges,presentationChangesForSession,presentationHead} from '../src/presentation-changes';

// Use an isolated schema shaped from the registry so the 69 static triggers are compiled and
// exercised without opening the owner's production state or running the application service.
const database=new Database(':memory:');
for(const [table,spec] of Object.entries(PRESENTATION_CHANGE_TABLES)) {
  const columns=new Set<string>();
  for(const expression of Object.values(spec))for(const match of expression.matchAll(/\{row\}\.([a-z_][a-z_0-9]*)/g))columns.add(match[1]!);
  database.exec(`CREATE TABLE "${table}" (${[...columns].map(column=>`"${column}" TEXT`).join(',')});`);
}
initializePresentationChanges(database);
for(const [table,spec] of Object.entries(PRESENTATION_CHANGE_TABLES)) {
  const columns=new Set<string>();
  for(const expression of Object.values(spec))for(const match of expression.matchAll(/\{row\}\.([a-z_][a-z_0-9]*)/g))columns.add(match[1]!);
  const row=Object.fromEntries([...columns].map(column=>[column,column==='payload_json'?'{}':'old']));
  const names=Object.keys(row);
  const insert=database.query(`INSERT INTO "${table}" (${names.map(name=>`"${name}"`).join(',')}) VALUES (${names.map(()=>'?').join(',')})`);
  insert.run(...Object.values(row));
  if(presentationHead(database)<1)throw new Error(`Missing insert trigger for ${table}`);
  database.query(`UPDATE "${table}" SET "${names[0]}"=?`).run('new');
  database.exec(`DELETE FROM "${table}"`);
}
const head=presentationHead(database);
try {database.transaction(()=>{database.exec(`INSERT INTO "sessions" ("id") VALUES ('rollback')`);throw new Error('abort');})();}
catch(error) {if(!(error instanceof Error)||error.message!=='abort')throw error;}
if(presentationHead(database)!==head)throw new Error('Journal outlived a rolled-back source mutation');
if(presentationChanges(database,0,head,1).length!==1)throw new Error('Bounded journal page failed');
database.exec(`INSERT INTO "sessions" ("id") VALUES ('1'),('2')`);
if(presentationChangesForSession(database,1,head,presentationHead(database),5).length!==1)
  throw new Error('A session delta included unrelated changes');
database.close();
console.log(`presentation journal: ${Object.keys(PRESENTATION_CHANGE_TABLES).length} dependency tables and atomic rollback checked`);
