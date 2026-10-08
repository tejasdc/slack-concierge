/** The durable address is shared by the canonical owner and its read projection. */
export function sessionAddress(session:{id:number;binding_generation?:number|null}):string{
 return 'session:'+Buffer.from(JSON.stringify([2,session.id,session.binding_generation??1])).toString('base64url');
}
