import type {Database} from 'bun:sqlite';

// Deleting a fixture's tables by a hand-written list breaks whenever a later
// migration adds a table that references one of them: the parent delete then
// fails its foreign key. The schema already knows every dependent, so the clear
// order is derived from it: each named table plus every table that references
// it (transitively), children deleted before their parents.
export function clearTables(db:Database,tables:readonly string[]){
  const all=(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(row=>row.name);
  const parentsOf=new Map<string,Set<string>>();
  for(const table of all){
    const parents=new Set((db.query(`SELECT "table" AS parent FROM pragma_foreign_key_list(?)`).all(table) as {parent:string}[]).map(row=>row.parent).filter(parent=>parent!==table));
    parentsOf.set(table,parents);
  }
  const selected=new Set(tables);
  for(let grew=true;grew;){
    grew=false;
    for(const [table,parents] of parentsOf)if(!selected.has(table)&&[...parents].some(parent=>selected.has(parent))){selected.add(table);grew=true;}
  }
  const ordered:string[]=[],done=new Set<string>();
  const visit=(table:string,path:Set<string>)=>{
    if(done.has(table)||path.has(table))return;
    path.add(table);
    for(const [child,parents] of parentsOf)if(selected.has(child)&&parents.has(table))visit(child,path);
    path.delete(table);done.add(table);ordered.push(table);
  };
  for(const table of selected)visit(table,new Set());
  for(const table of ordered)db.query(`DELETE FROM "${table}"`).run();
}
