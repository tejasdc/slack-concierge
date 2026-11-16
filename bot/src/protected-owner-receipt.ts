import {ledgerDurable} from './ledger-durability-barrier';
import {protectedDurability} from './protected-durability-observation';

/** Begins before handling; ends after durable coverage and before handing the response back. */
export async function protectedOwnerReceipt<T>(handle:()=>Promise<T>,id?:string):Promise<T> {
  const observation=protectedDurability.begin('owner_receipt');
  try {
    const response=await handle();
    await ledgerDurable({kind:'owner_receipt',id,observation});
    observation.finish(observation.proof);
    return response;
  } catch(error){observation.finish(4);throw error;}
}
