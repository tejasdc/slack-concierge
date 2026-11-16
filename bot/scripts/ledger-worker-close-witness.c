#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/syscall.h>
/* Fixture only. SQLite invokes xDestroy at actual native connection deallocation,
 * including after any close_v2 zombie drains. This is independent of Bun's closed flag. */
static void closed(void *data){
 const char *path=(const char*)data;FILE *out=fopen(path,"a");
 if(out){fprintf(out,"sqlite-native-deallocated pid=%d tid=%ld\n",getpid(),syscall(SYS_gettid));fclose(out);}free(data);
}
static void noop(sqlite3_context *context,int argc,sqlite3_value **argv){(void)argc;(void)argv;sqlite3_result_null(context);}
static void registerWitness(sqlite3_context *context,int argc,sqlite3_value **argv){
 (void)argc;const char *path=(const char*)sqlite3_value_text(argv[0]);if(!path){sqlite3_result_error(context,"witness path required",-1);return;}
 char *owned=strdup(path);int rc=sqlite3_create_function_v2(sqlite3_context_db_handle(context),"fixture_native_lifetime",0,SQLITE_UTF8,owned,noop,0,0,closed);
 if(rc!=SQLITE_OK){sqlite3_result_error(context,"register native close witness failed",-1);return;}sqlite3_result_int(context,1);
}
int sqlite3_closewitness_init(sqlite3 *db,char **error,const sqlite3_api_routines *api){
 (void)error;SQLITE_EXTENSION_INIT2(api);return sqlite3_create_function_v2(db,"fixture_register_close",1,SQLITE_UTF8,0,registerWitness,0,0,0);
}
