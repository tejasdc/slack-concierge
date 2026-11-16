import {AsyncLocalStorage} from 'node:async_hooks';

/** The async scope that carries an agent reader through one owner request. Kept free of
 * other imports so shared background loops can leave it without loading the ledger. */
export const contentReaderScope=new AsyncLocalStorage<any>();

/** Shared background loops serve every session; they never inherit the reader of the request
 * that happened to wake them. */
export function outsideContentReader<T>(work:()=>T):T {return contentReaderScope.exit(work);}
