#define _GNU_SOURCE
#include <dlfcn.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
static int (*real_sync)(int);
static int (*real_data_sync)(int);
static int phase=0;
static int receipts=0;
static void marker(const char *suffix,const char *kind,const char *path){
 const char *root=getenv("LEDGER_LATCH_ROOT");if(!root)return;
 char name[4096];snprintf(name,sizeof(name),"%s/%s",root,suffix);
 int fd=open(name,O_CREAT|O_WRONLY|O_APPEND,0600);
 if(fd>=0){dprintf(fd,"%s tid=%ld path=%s\n",kind,syscall(SYS_gettid),path);close(fd);}
}
static int exists(const char *suffix){
 char name[4096];snprintf(name,sizeof(name),"%s/%s",getenv("LEDGER_LATCH_ROOT"),suffix);return access(name,F_OK)==0;
}
static void hold(const char *entered,const char *release,const char *kind,const char *path){
 marker(entered,kind,path);struct timespec delay={0,1000000};
 for(int i=0;i<30000&&!exists(release);i++)nanosleep(&delay,0);
}
int fsync(int fd){
 if(!real_sync)real_sync=dlsym(RTLD_NEXT,"fsync");
 const char *db=getenv("LEDGER_LATCH_DB"),*root=getenv("LEDGER_LATCH_ROOT");
 if(!db||!root||!exists("armed"))return real_sync(fd);
 char proc[64],path[4096];snprintf(proc,sizeof(proc),"/proc/self/fd/%d",fd);
 ssize_t n=readlink(proc,path,sizeof(path)-1);if(n<0)return real_sync(fd);path[n]=0;
 char wal[4096];snprintf(wal,sizeof(wal),"%s-wal",db);
 if(strcmp(path,wal)==0){
  marker("sync.log","wal-fsync",path);
  if(__sync_bool_compare_and_swap(&phase,1,2))hold("header.entered","header.release","primer-header-fsync",path);
 }
 if(strcmp(path,db)==0&&__sync_bool_compare_and_swap(&phase,0,-1)){
  hold("checkpoint.entered","checkpoint.release","checkpoint-main-fsync",path);
  int result=real_sync(fd);__sync_synchronize();phase=1;return result;
 }
 return real_sync(fd);
}
int fdatasync(int fd){
 if(!real_data_sync)real_data_sync=dlsym(RTLD_NEXT,"fdatasync");
 const char *db=getenv("LEDGER_LATCH_DB"),*root=getenv("LEDGER_LATCH_ROOT");
 if(!db||!root||!exists("hold-receipt"))return real_data_sync(fd);
 char proc[64],path[4096],wal[4096];snprintf(proc,sizeof(proc),"/proc/self/fd/%d",fd);
 ssize_t n=readlink(proc,path,sizeof(path)-1);if(n<0)return real_data_sync(fd);path[n]=0;
 snprintf(wal,sizeof(wal),"%s-wal",db);
 if(strcmp(path,wal)==0){
  int receipt=__sync_add_and_fetch(&receipts,1);
  if(receipt<=2){char entered[64],release[64];snprintf(entered,sizeof(entered),"receipt%d.entered",receipt);snprintf(release,sizeof(release),"receipt%d.release",receipt);hold(entered,release,"original-descriptor-fdatasync",path);}
 }
 return real_data_sync(fd);
}
