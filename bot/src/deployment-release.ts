import { createHash, randomUUID } from "node:crypto";
import { privateCodeCommand } from './private-database-command';
import {runPrivatePresentationCheck} from './private-presentation-check';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  rmdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import BUILT_IN_DECLARATION from "./deployment-artifact-files.json";
import {assertHistoryCacheActivation,HISTORY_CACHE_CAPABILITY_PATH,HISTORY_CACHE_CONTROL_CAPABILITY_PATH} from "./provider-history-cache-compatibility";
import {assertCustodyReaderActivation,CUSTODY_APPLICATION_CAPABILITY_PATH,CUSTODY_CONTROL_CAPABILITY_PATH,type CustodyApplicationProvenance} from './codex-custody-compatibility';
import {authorityCapability,captureManagedLaunches,commandCapability,launchAuthorityReferences,saveLaunchBootstrap,semanticCommandPath,selectedLedgerProcesses,RELEASE_LEDGER_HELPERS,withLaunchSelection} from './deployment-launch-authority';
import {isLiveLedgerPath} from './ledger-access-policy';
import RELEASE_CHECK_POLICY from '../scripts/release-check-policy.json';

// The candidate supervises its complete check and descendant cleanup within the same
// maintained release budget. GNU timeout is the independent outer kill boundary.
export const CANDIDATE_PRESENTATION_TIMEOUT_SECONDS = RELEASE_CHECK_POLICY.deadlineMs/1000;
export const CANDIDATE_PRESENTATION_CLEANUP_SECONDS = RELEASE_CHECK_POLICY.cleanupMs/1000;

export function failedCandidateCheck(result: {
  exitCode: number | null;
  signal?: string | number | null;
  stdout?: string | Uint8Array | null;
  stderr?: string | Uint8Array | null;
  error?: Error | null;
  timeoutSeconds?: number;
  evidencePath?: string | null;
}): string {
  const timeout = result.timeoutSeconds &&
    (result.exitCode === 124 || (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT');
  const status = timeout ? `timed out after ${result.timeoutSeconds} seconds (exit status ${result.exitCode ?? 'none'})`
    : result.signal ? `terminated by signal ${result.signal} (exit status ${result.exitCode ?? 'none'})`
    : `exit status ${result.exitCode ?? 'none'}`;
  const tail = (value?: string | Uint8Array | null) =>
    Buffer.from(value ?? '').subarray(-2000).toString('utf8') || '(empty)';
  const firstFailure = firstFailureLine(Buffer.from(result.stderr ?? '').toString('utf8'))
    ?? firstFailureLine(Buffer.from(result.stdout ?? '').toString('utf8'));
  return `${status}${result.error ? `; process error: ${result.error.message.slice(-500)}` : ''}`
    + `${firstFailure ? `\nfirst failure: ${firstFailure}` : ''}`
    + `${result.evidencePath ? `\ncomplete output: ${result.evidencePath}` : ''}`
    + `\nstdout tail:\n${tail(result.stdout)}\nstderr tail:\n${tail(result.stderr)}`;
}

// The tail alone lost the assertion of run b264626d (2026-10-21): the failing line sat
// before kilobytes of fixture diagnostics, so the repair agent parked for lack of evidence.
// The check names each lifecycle failure on its own line; otherwise prefer the printed error
// over Bun's source excerpt, whose lines also mention assert.
export function firstFailureLine(text: string): string | null {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('at '));
  const named = lines.find(line => line.startsWith('presentation-check: lifecycle failure: '));
  const plain = lines.filter(line => !line.startsWith('{') && !line.startsWith('presentation-check: '));
  const found = named ?? plain.find(line => /^(error:|[A-Z][A-Za-z]*Error\b)/.test(line))
    ?? plain.find(line => /\b(assert|failed|deadline|did not)\b/i.test(line));
  return found?.slice(0, 1000) ?? null;
}

const EVIDENCE_HEAD_BYTES = 256 * 1024;
const EVIDENCE_TAIL_BYTES = 768 * 1024;
const RETAINED_EVIDENCE_RUNS = 20;

function boundedEvidence(value?: string | Uint8Array | null) {
  const bytes = Buffer.from(value ?? '');
  if (bytes.length <= EVIDENCE_HEAD_BYTES + EVIDENCE_TAIL_BYTES) return bytes;
  return Buffer.concat([bytes.subarray(0, EVIDENCE_HEAD_BYTES),
    Buffer.from(`\n… ${bytes.length - EVIDENCE_HEAD_BYTES - EVIDENCE_TAIL_BYTES} bytes omitted …\n`),
    bytes.subarray(-EVIDENCE_TAIL_BYTES)]);
}

/** Keep a failed candidate check's output outside staging, which is removed after the attempt. */
export function retainCandidateCheckEvidence(releaseRoot: string, attemptId: string, check: string,
  result: { stdout?: string | Uint8Array | null; stderr?: string | Uint8Array | null }): string | null {
  try {
    const root = join(releaseRoot, 'candidate-check-failures');
    const directory = join(root, `${attemptId}-${check}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, 'stdout.log'), boundedEvidence(result.stdout), { mode: 0o600 });
    writeFileSync(join(directory, 'stderr.log'), boundedEvidence(result.stderr), { mode: 0o600 });
    const retained = readdirSync(root).map(name => ({ name, at: lstatSync(join(root, name)).mtimeMs }))
      .sort((left, right) => right.at - left.at);
    for (const old of retained.slice(RETAINED_EVIDENCE_RUNS)) rmSync(join(root, old.name), { recursive: true, force: true });
    return directory;
  } catch {
    return null;
  }
}

export interface ReleaseManifest {
  format: 2;
  git_commit: string;
  control_git_commit: string;
  source_tree_digest: string;
  control_source_tree_digest: string;
  runtime_digest: string;
  compatibility_digest: string;
  artifact_digest: string;
  files: Record<string, string>;
  application_bundle_source_digest?: string;
  custody_application_provenance?:CustodyApplicationProvenance;
}

export interface PreparedRelease {
  artifactPath: string;
  manifest: ReleaseManifest;
}

export interface ReleaseEnvironment {
  repositoryRoot: string;
  releaseRoot: string;
  installRoot: string;
  bunExecutable: string;
  historyCacheStateDirectory?: string;
  custodyStateDirectory?:string;
}

interface SpawnResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface ReleaseServices {
  spawn(command: string[], options?: { cwd?: string; stdin?: Uint8Array; env?: NodeJS.ProcessEnv }): SpawnResult;
  presentation?(command:string[],cwd:string,environment:NodeJS.ProcessEnv):Promise<SpawnResult>;
  build(entrypoint: string, outputFile: string, target?: "bun" | "node"): Promise<void>;
}

const APPLICATION_FILES = [
  "bot/src/index.js",
  "bot/src/codex-app-server-bridge.mjs",
  "bot/scripts/rename-exchange.py",
];

// What goes into a release's control directory is declared once, in
// deployment-artifact-files.json, and read from the source being packaged — never from the
// code doing the packaging. The two differ during every rollout (the running control builds
// the next candidate), and on September 21, 2026 that difference stranded deployments: the
// running control's older list left a newly added file out of a release whose own code
// required it, so the release could not verify itself and every later deploy refused to run.
// See docs/architecture/DEPLOYMENT-REPAIR.md, "Artifact contents".

interface ArtifactDeclaration {
  controlBundles: Record<string, string>;
  controlFiles: Record<string, string>;
  applicationBundles: string[];
}

function checkedDeclaration(value: unknown, label: string): ArtifactDeclaration {
  const candidate = value as { format?: unknown; controlBundles?: unknown; controlFiles?: unknown; applicationBundles?:unknown } | null;
  if (!candidate || candidate.format !== 1) throw new Error(`${label} has an unsupported format.`);
  const table = (entries: unknown, name: string, sourcePattern: RegExp) => {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error(`${label} ${name} is not a table.`);
    const result: Record<string, string> = {};
    for (const [destination, source] of Object.entries(entries as Record<string, unknown>)) {
      if (!/^control\/[A-Za-z0-9@._\/-]+$/.test(destination) || destination.includes("..")
        || typeof source !== "string" || source.includes("..") || source.startsWith("/") || !sourcePattern.test(source)) {
        throw new Error(`${label} ${name} entry ${destination} is not a safe release path.`);
      }
      result[destination] = source;
    }
    return result;
  };
  const controlBundles=table(candidate.controlBundles, "controlBundles", /^bot\/[A-Za-z0-9._\/-]+\.ts$/);
  const applicationBundles=candidate.applicationBundles??[];
  if(!Array.isArray(applicationBundles)||applicationBundles.some(path=>typeof path!=='string'||!path.startsWith('control/application/')||!controlBundles[path]))
    throw new Error(`${label} application bundles must name declared application paths.`);
  return {
    controlBundles,
    controlFiles: table(candidate.controlFiles, "controlFiles", /^[A-Za-z0-9._\/@-]+$/),
    applicationBundles:[...new Set(applicationBundles)],
  };
}

const BUILT_IN = checkedDeclaration(BUILT_IN_DECLARATION, "Built-in artifact declaration");

// A source that predates the declaration file (an old commit being rebuilt) uses this code's list.
function declarationFor(controlSourceRoot: string): ArtifactDeclaration {
  const path = join(controlSourceRoot, "bot/src/deployment-artifact-files.json");
  if (!existsSync(path)) return {...BUILT_IN,applicationBundles:[],controlBundles:Object.fromEntries(
    Object.entries(BUILT_IN.controlBundles).filter(([destination])=>!BUILT_IN.applicationBundles.includes(destination)))};
  return checkedDeclaration(JSON.parse(readFileSync(path, "utf8")), "Candidate artifact declaration");
}

function runtimeFilesFor(declaration: ArtifactDeclaration) {
  return [
    ...APPLICATION_FILES,
    "control/codex-app-server-bridge.mjs",
    ...Object.keys(declaration.controlBundles),
    ...Object.keys(declaration.controlFiles),
  ].sort();
}

// The stable launcher runs these by name; a release without them could not deploy or repair.
const LAUNCHER_ENTRYPOINTS = ["control/deploy.sh", "control/deployment-repair.js", "control/release-manager.js"];
const RUNTIME_DISPATCH_HEADER='#!/bin/sh\n# Concierge runtime dispatch v1\n';

const COMPATIBILITY_FILES = [
  "bot/src/state.ts",
  "bot/src/capture-state.ts",
  "bot/src/deployment-state.ts",
];

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function assertCommit(value: string) {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Release commit must be a full lowercase Git SHA.");
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} is not a SHA-256 digest.`);
  }
}

function assertInside(root: string, path: string) {
  const relativePath = relative(resolve(root), resolve(path));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep)) {
    throw new Error(`${path} escapes ${root}.`);
  }
}

function listRegularFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Release tree contains symlink ${path}.`);
    if (stat.isDirectory()) {
      files.push(...listRegularFiles(root, path));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Release tree contains special file ${path}.`);
    files.push(relative(root, path).split(sep).join("/"));
  }
  return files.sort();
}

export function releaseFileSetDigest(root: string, paths: string[]) {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    const contents = readFileSync(join(root, path));
    hash.update(`${path}\0${contents.byteLength}\0`);
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function makeReadOnly(path: string) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) makeReadOnly(join(path, entry));
    chmodSync(path, 0o555);
    return;
  }
  chmodSync(path, (stat.mode & 0o111) ? 0o555 : 0o444);
}

function defaultServices(): ReleaseServices {
  return {
    presentation:runPrivatePresentationCheck,
    spawn(command, options = {}) {
      return Bun.spawnSync({
        cmd: command,
        cwd: options.cwd,
        env: options.env,
        stdin: options.stdin,
        stdout: "pipe",
        stderr: "pipe",
      }) as SpawnResult;
    },
    async build(entrypoint, outputFile, target = "bun") {
      const result = await Bun.build({
        entrypoints: [entrypoint],
        target,
        format: target === "node" ? "esm" : undefined,
        outdir: dirname(outputFile),
        naming: basename(outputFile),
      });
      if (!result.success) {
        throw new Error(`Application bundle failed: ${result.logs.map((entry) => entry.message).join("\n").slice(0, 4000)}`);
      }
    },
  };
}

export function defaultReleaseEnvironment(repositoryRoot: string): ReleaseEnvironment {
  return {
    repositoryRoot,
    releaseRoot: process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT || "/var/lib/slack-concierge-deployment",
    installRoot: process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR || "/usr/local/lib/slack-concierge-deployment",
    bunExecutable: process.env.CONCIERGE_BUN_BIN || "/root/.bun/bin/bun",
    historyCacheStateDirectory: process.env.CONCIERGE_STATE_DIR || "/root/.local/state/concierge",
    custodyStateDirectory:process.env.CONCIERGE_STATE_DIR||"/root/.local/state/concierge",
  };
}

export class TrustedRootReleaseManager {
  constructor(
    readonly environment: ReleaseEnvironment,
    readonly services: ReleaseServices = defaultServices(),
  ) {}

  private custodyRowsExist(candidateArtifact:string,candidateFiles:Record<string,string>):boolean {
    const database=join(this.environment.custodyStateDirectory??this.environment.historyCacheStateDirectory??'/root/.local/state/concierge','state.db');
    // A genuinely new installation has no ledger and cannot yet contain custody rows.
    if(!existsSync(database))return false;
    const selectedControl=this.controlArtifactPath();
    const readerPath='control/ledger-read.py';
    let reader:string|null=null;
    if(selectedControl){
      const current=this.verify(selectedControl);
      const path=join(selectedControl,readerPath);
      if(current.files[readerPath]&&existsSync(path)
        &&digest(readFileSync(path))===current.files[readerPath])reader=path;
    }
    if(!reader){
      const path=join(candidateArtifact,readerPath);
      if(candidateFiles[readerPath]&&existsSync(path)&&digest(readFileSync(path))===candidateFiles[readerPath])reader=path;
    }
    if(!reader)throw new Error('CODEX_CUSTODY_READ_ENTRANCE_UNAVAILABLE');
    const sql='SELECT EXISTS(SELECT 1 FROM codex_custody_successors LIMIT 1) AS required';
    const result=this.services.spawn(['/usr/bin/python3',reader,
      '--database',database,'--max-rows','1',sql],{cwd:this.environment.repositoryRoot});
    if(result.exitCode!==0) {
      // Before this feature's schema exists, the bounded read reports its absence. Every other
      // reader failure fails closed so activation cannot silently lose the state requirement.
      if(Buffer.from(result.stderr).toString('utf8').includes('no such table: codex_custody_successors'))return false;
      throw new Error(`CODEX_CUSTODY_LEDGER_READ_FAILED: ${Buffer.from(result.stderr).toString('utf8').slice(-1000)}`);
    }
    const line=Buffer.from(result.stdout).toString('utf8').trim().split('\n').at(-1);
    const row=line?JSON.parse(line) as {required?:unknown}:null;
    if(typeof row?.required!=='number'&&typeof row?.required!=='boolean')throw new Error('CODEX_CUSTODY_LEDGER_READ_INVALID');
    return row.required===1||row.required===true;
  }

  private assertCustodyReader(artifact:string,manifest:ReleaseManifest,control:boolean) {
    if(this.environment.custodyStateDirectory)
      assertCustodyReaderActivation(this.environment.custodyStateDirectory,artifact,manifest.files,control,this.custodyRowsExist(artifact,manifest.files),{
        applicationCommit:manifest.git_commit,controlCommit:manifest.control_git_commit,
        applicationSourceTreeDigest:manifest.source_tree_digest,custodyApplicationProvenance:manifest.custody_application_provenance});
  }

  private verifyRuntimeLaunchers(artifactPath: string) {
    const manifest = this.verify(artifactPath);
    for (const path of ["control/deployment-launcher.sh", "control/deployment-control-launcher.sh"]) {
      if (!manifest.files[path]) throw new Error(`Release is missing runtime launcher ${path}.`);
    }
    const sealed = (path: string) => {
      const stat = lstatSync(path);
      if (stat.mode & 0o222) throw new Error(`Runtime release is not sealed: ${path}.`);
      if (stat.isDirectory()) for (const entry of readdirSync(path)) sealed(join(path, entry));
    };
    sealed(artifactPath);
    return manifest;
  }

  /** Synchronous preflight for operations that must validate before recording an owner mutation. */
  verifyControlActivation(artifactPath:string) {
    const canonical=realpathSync(artifactPath),manifest=this.verifyRuntimeLaunchers(canonical);
    if(this.environment.historyCacheStateDirectory)
      assertHistoryCacheActivation(this.environment.historyCacheStateDirectory,canonical,manifest.files,true);
    this.assertCustodyReader(canonical,manifest,true);
    return manifest;
  }

  private installRuntimeLaunchers() {
    return withLaunchSelection(()=>{
    mkdirSync(this.environment.installRoot, { recursive: true, mode: 0o755 });
    const capable=[this.currentArtifactPath(),this.controlArtifactPath()].find(path=>path&&(commandCapability(path)||authorityCapability(path)));
    const anchorPath=join(this.environment.releaseRoot,'launch-authority','selected.json');
    let authority=capable;
    let installedEngine:string|null=null;
    if(!authority&&existsSync(anchorPath))authority=JSON.parse(readFileSync(anchorPath,'utf8')).artifact;
    if(authority){
      const manifest=this.verifyRuntimeLaunchers(authority);
      for(const name of [relative(authority,semanticCommandPath(authority,'deployment-launch-authority'))])
        if(!manifest.files[name])throw Error('Selected release lacks its command authority.');
      const rawEngine=join(this.environment.installRoot,'bun-engine');
      if(!existsSync(rawEngine)){
        copyFileSync(realpathSync(join(this.environment.installRoot,'bun')),rawEngine);chmodSync(rawEngine,0o555);
      }
      const engineBytes=readFileSync(rawEngine),engineDigest=digest(engineBytes);
      const engineDirectory=join(this.environment.installRoot,'engines',engineDigest),engine=join(engineDirectory,'bun');
      installedEngine=engine;
      if(existsSync(engine)){
        if(digest(readFileSync(engine))!==engineDigest||lstatSync(engine).mode&0o222)throw Error('Installed immutable engine identity changed.');
      }else{
        mkdirSync(dirname(engineDirectory),{recursive:true,mode:0o755});
        const temporary=engineDirectory+'.'+randomUUID()+'.tmp';mkdirSync(temporary,{mode:0o700});
        writeFileSync(join(temporary,'bun'),engineBytes,{mode:0o555});chmodSync(temporary,0o555);renameSync(temporary,engineDirectory);
      }
      const enginePointer=rawEngine+'.'+randomUUID()+'.tmp';
      symlinkSync(relative(this.environment.installRoot,engine),enginePointer);renameSync(enginePointer,rawEngine);
      const root=join(this.environment.releaseRoot,'launch-authority');mkdirSync(root,{recursive:true,mode:0o700});
      const entry=semanticCommandPath(authority,'deployment-launch-authority');
      const temp=anchorPath+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify({format:1,artifact:authority,entry,engine,engineDigest}),{mode:0o600});renameSync(temp,anchorPath);
      const quote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
      const prefix=`${RUNTIME_DISPATCH_HEADER}set -eu\nexport CONCIERGE_DEPLOYMENT_RELEASE_ROOT=${quote(this.environment.releaseRoot)}\nexport CONCIERGE_DEPLOYMENT_RUNTIME_DIR=${quote(this.environment.installRoot)}\nENGINE=${quote(engine)}\n`;
      const selectedEntry=`ENTRY=$(/usr/bin/python3 -I -S -c 'import json,sys; print(json.load(open(sys.argv[1]))["entry"])' ${quote(anchorPath)})\n`;
      for(const [name,mode] of [['bun','bun'],['control','control']]){
        const target=join(this.environment.installRoot,name),temporary=target+'.'+randomUUID()+'.tmp';
        const commands=RELEASE_LEDGER_HELPERS.flatMap(name=>[name+'.js',name+'.ts']).join('|');
        const dispatch=name==='bun'
          ?`MAIN=\${1:-}\nif [ "$MAIN" = run ]; then MAIN=\${2:-}; fi\ncase "\${MAIN##*/}" in\n${commands})\n${selectedEntry}exec "$ENGINE" "$ENTRY" bun "$@";;\n*) exec "$ENGINE" "$@";;\nesac\n`
          :selectedEntry+'exec "$ENGINE" "$ENTRY" control "$@"\n';
        writeFileSync(temporary,prefix+dispatch,{mode:0o555});renameSync(temporary,target);
      }
      // Existing old jobs can already have selected an executable. Later selections
      // see the machine wrappers above; keep the former cgroups until native exit.
      if(process.env.CONCIERGE_STATE_DIR&&isLiveLedgerPath(join(process.env.CONCIERGE_STATE_DIR,'state.db'))&&existsSync('/run/systemd/system'))
        saveLaunchBootstrap({...captureManagedLaunches(authority,args=>{
          const result=this.services.spawn(['/usr/bin/systemctl',...args]);
          if(result.exitCode!==0)throw Error('Cannot establish managed release launch custody.');
          return Buffer.from(result.stdout).toString('utf8');
        }),processes:selectedLedgerProcesses()});
    }
    for (const [name, source] of [["launch", "deployment-launcher.sh"], ["control", "deployment-control-launcher.sh"]]) {
      if(authority&&name==='control')continue;
      const destination = join(this.environment.installRoot, name);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        // Keep the installed entrypoint independent of a release's command vocabulary.
        // Older sealed shell launchers are not executable, so invoke Bash explicitly.
        const root = resolve(this.environment.releaseRoot).replace(/'/g, "'\\''");
        const script=authority&&name==='launch'
          ?`#!/bin/sh\nset -eu\nRELEASE_ROOT=\${CONCIERGE_DEPLOYMENT_RELEASE_ROOT:-'${root}'}\nARTIFACT=$(/usr/bin/readlink -f "$RELEASE_ROOT/current")\ncd "$ARTIFACT"\nexport CONCIERGE_RELEASE_MANIFEST="$ARTIFACT/manifest.json"\nexec '${installedEngine!.replace(/'/g,"'\\''")}' "$ARTIFACT/bot/src/index.js" "$@"\n`
          :`#!/bin/sh\nset -eu\nRELEASE_ROOT=\${CONCIERGE_DEPLOYMENT_RELEASE_ROOT:-'${root}'}\nexec /usr/bin/bash "$RELEASE_ROOT/control/control/${source}" "$@"\n`;
        writeFileSync(temporary, script,
          { mode: 0o555, flag: "wx" });
        chmodSync(temporary, 0o555);
        renameSync(temporary, destination);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    },join(this.environment.releaseRoot,'launch-authority'));
  }

  installRuntime() {
    const artifact = this.controlArtifactPath();
    if (!artifact) throw new Error("Cannot install runtime without a verified control release.");
    this.verifyRuntimeLaunchers(artifact);
    mkdirSync(this.environment.installRoot, { recursive: true, mode: 0o755 });
    const capable=authorityCapability(artifact)||commandCapability(artifact)||(this.currentArtifactPath()&&commandCapability(this.currentArtifactPath()!));
    const bunDestination = join(this.environment.installRoot, capable?"bun-engine":"bun");
    const temporaryBun = `${bunDestination}.${randomUUID()}.tmp`;
    try {
      const executable=resolve(this.environment.bunExecutable)===join(this.environment.installRoot,'bun')&&existsSync(join(this.environment.installRoot,'bun-engine'))
        ?join(this.environment.installRoot,'bun-engine'):realpathSync(this.environment.bunExecutable);
      copyFileSync(executable, temporaryBun);
      chmodSync(temporaryBun, 0o555);
      renameSync(temporaryBun, bunDestination);
      this.installRuntimeLaunchers();
    } finally {
      rmSync(temporaryBun, { force: true });
    }
  }

  installSelectedRuntimeLaunchers() {
    const artifact = this.controlArtifactPath();
    if (!artifact) throw new Error("Cannot install runtime without a verified control release.");
    this.verifyRuntimeLaunchers(artifact);
    this.installRuntimeLaunchers();
  }

  async prepare(attemptId: string, gitCommit: string, controlGitCommit = gitCommit): Promise<PreparedRelease> {
    assertCommit(gitCommit);
    assertCommit(controlGitCommit);
    if (!/^[0-9a-z-]{8,100}$/.test(attemptId)) throw new Error("Release attempt identity is invalid.");
    const stagingRoot = join(this.environment.releaseRoot, "staging", `${attemptId}-${randomUUID()}`);
    const sourceRoot = join(stagingRoot, "source");
    const controlSourceRoot = join(stagingRoot, "control-source");
    const outputRoot = join(stagingRoot, "release");
    mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(controlSourceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

    try {
      const extractCommit = (commit: string, destination: string) => {
        const archive = this.services.spawn([
          "/usr/bin/git", "-C", this.environment.repositoryRoot, "archive", "--format=tar", commit,
        ]);
        if (archive.exitCode !== 0) {
          throw new Error(`Git archive failed for ${commit}: ${Buffer.from(archive.stderr).toString("utf8").slice(0, 1000)}`);
        }
        const extracted = this.services.spawn(["/usr/bin/tar", "-xf", "-", "-C", destination], { stdin: archive.stdout });
        if (extracted.exitCode !== 0) {
          throw new Error(`Release extraction failed for ${commit}: ${Buffer.from(extracted.stderr).toString("utf8").slice(0, 1000)}`);
        }
        return digest(archive.stdout);
      };
      const sourceTreeDigest = extractCommit(gitCommit, sourceRoot);
      const controlSourceTreeDigest = controlGitCommit === gitCommit
        ? sourceTreeDigest
        : extractCommit(controlGitCommit, controlSourceRoot);
      const effectiveControlSourceRoot = controlGitCommit === gitCommit ? sourceRoot : controlSourceRoot;
      const dependencyRoot = realpathSync(join(this.environment.repositoryRoot, "bot/node_modules"));
      symlinkSync(dependencyRoot, join(sourceRoot, "bot/node_modules"), "dir");
      if (effectiveControlSourceRoot !== sourceRoot) {
        symlinkSync(dependencyRoot, join(effectiveControlSourceRoot, "bot/node_modules"), "dir");
      }
      // Run the candidate's isolated growth checks before sealing any runnable artifact.
      // This executes in the update runner, not the interactive owner process.
      const applicationDeclaration=declarationFor(sourceRoot);
      const hasPresentationGate=existsSync(join(sourceRoot,'bot/scripts/presentation-release-check.ts'));
      if(applicationDeclaration.applicationBundles.length&&!hasPresentationGate)
        throw new Error('Candidate application is missing its presentation release check.');
      const presentationEnvironment={...process.env,CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:'responsive-system-b1eed622',
        CONCIERGE_STATE_DIR:join(stagingRoot,'isolated-owner'),CONCIERGE_STATE_DB:join(stagingRoot,'isolated-owner/state.db'),
        CONCIERGE_CAPTURE_STATE_DIR:join(stagingRoot,'isolated-capture'),CONCIERGE_PRIVATE_CODE_STATE:join(stagingRoot,'isolated-owner')};
      const presentationCheck=hasPresentationGate?(this.services.presentation
        ?await this.services.presentation([this.environment.bunExecutable,join(sourceRoot,'bot/scripts/presentation-release-check.ts'),'--bounded-child'],
          join(sourceRoot,'bot'),presentationEnvironment)
        :(()=>{
          // Nested private sandboxes need the code boundary, not the capability-less database one.
          const isolated=privateCodeCommand([
            '/usr/bin/timeout',`--kill-after=${CANDIDATE_PRESENTATION_CLEANUP_SECONDS}`,String(CANDIDATE_PRESENTATION_TIMEOUT_SECONDS),'/usr/bin/env','--unset=CONCIERGE_FIXTURE_SHARED_GROUP','CONCIERGE_TEST_MODE=1','CONCIERGE_TEST_AUTHORIZATION=responsive-system-b1eed622',
            `CONCIERGE_STATE_DIR=${join(stagingRoot,'isolated-owner')}`,`CONCIERGE_CAPTURE_STATE_DIR=${join(stagingRoot,'isolated-capture')}`,
            this.environment.bunExecutable,
            join(sourceRoot,'bot/scripts/presentation-release-check.ts'),
          ],process.env);
          try{return this.services.spawn(isolated.command,{cwd:join(sourceRoot,'bot'),env:isolated.environment});}
          finally{isolated.cleanup();}
        })()):null;
      if(presentationCheck&&presentationCheck.exitCode!==0)throw new Error(
        `Candidate presentation cost check failed: ${failedCandidateCheck({...presentationCheck,
          timeoutSeconds:CANDIDATE_PRESENTATION_TIMEOUT_SECONDS,
          evidencePath:retainCandidateCheckEvidence(this.environment.releaseRoot,attemptId,'presentation',presentationCheck)})}`);
      mkdirSync(join(outputRoot, "bot/src"), { recursive: true, mode: 0o700 });
      mkdirSync(join(outputRoot, "bot/scripts"), { recursive: true, mode: 0o700 });
      mkdirSync(join(outputRoot, "control"), { recursive: true, mode: 0o700 });
      await this.services.build(join(sourceRoot, "bot/src/index.ts"), join(outputRoot, "bot/src/index.js"));
      await this.services.build(
        join(sourceRoot, "bot/src/codex-app-server-bridge.mjs"),
        join(outputRoot, "bot/src/codex-app-server-bridge.mjs"),
        "node",
      );
      const controlDeclaration=declarationFor(effectiveControlSourceRoot);
      // Keep the namespace understood by older builders, but a hybrid's application workers
      // always come from its application commit, never the independently upgraded control.
      const applicationPaths=new Set(applicationDeclaration.applicationBundles);
      const controlFiles={...controlDeclaration.controlFiles};
      const launcherCapability = "control/deployment-runtime-launchers.json";
      if (controlFiles[launcherCapability] && !existsSync(join(effectiveControlSourceRoot, controlFiles[launcherCapability])))
        delete controlFiles[launcherCapability];
      const controllerCapability=controlFiles[HISTORY_CACHE_CONTROL_CAPABILITY_PATH];
      if(controllerCapability && !existsSync(join(effectiveControlSourceRoot,controllerCapability)))delete controlFiles[HISTORY_CACHE_CONTROL_CAPABILITY_PATH];
      const custodyController=controlFiles[CUSTODY_CONTROL_CAPABILITY_PATH];
      if(custodyController&&!existsSync(join(effectiveControlSourceRoot,custodyController)))delete controlFiles[CUSTODY_CONTROL_CAPABILITY_PATH];
      // Reader capability belongs to the application commit, even in a hybrid
      // artifact with a separately upgraded deployment controller.
      delete controlFiles[HISTORY_CACHE_CAPABILITY_PATH];
      const readerCapability=applicationDeclaration.controlFiles[HISTORY_CACHE_CAPABILITY_PATH];
      if(readerCapability && existsSync(join(sourceRoot,readerCapability)))controlFiles[HISTORY_CACHE_CAPABILITY_PATH]=readerCapability;
      const custodyReader=applicationDeclaration.controlFiles[CUSTODY_APPLICATION_CAPABILITY_PATH];
      delete controlFiles[CUSTODY_APPLICATION_CAPABILITY_PATH];
      if(custodyReader&&existsSync(join(sourceRoot,custodyReader)))controlFiles[CUSTODY_APPLICATION_CAPABILITY_PATH]=custodyReader;
      const declaration={...controlDeclaration,controlFiles,controlBundles:{...controlDeclaration.controlBundles,
        ...Object.fromEntries([...applicationPaths].map(path=>[path,applicationDeclaration.controlBundles[path]!]))}};
      const runtimeFiles = runtimeFilesFor(declaration);
      for (const [destination, source] of Object.entries(declaration.controlBundles)) {
        mkdirSync(dirname(join(outputRoot, destination)), { recursive: true, mode: 0o700 });
        await this.services.build(join(applicationPaths.has(destination)?sourceRoot:effectiveControlSourceRoot, source), join(outputRoot, destination));
      }
      for (const [destination, source] of Object.entries(declaration.controlFiles)) {
        mkdirSync(dirname(join(outputRoot, destination)), { recursive: true, mode: 0o700 });
        copyFileSync(join(destination===HISTORY_CACHE_CAPABILITY_PATH||destination===CUSTODY_APPLICATION_CAPABILITY_PATH?sourceRoot:effectiveControlSourceRoot, source), join(outputRoot, destination));
      }
      await this.services.build(
        join(effectiveControlSourceRoot, "bot/src/codex-app-server-bridge.mjs"),
        join(outputRoot, "control/codex-app-server-bridge.mjs"),
        "node",
      );
      copyFileSync(
        join(sourceRoot, "bot/scripts/rename-exchange.py"),
        join(outputRoot, "bot/scripts/rename-exchange.py"),
      );
      const runtimeDigest = releaseFileSetDigest(outputRoot, runtimeFiles);
      const compatibilityDigest = releaseFileSetDigest(sourceRoot, COMPATIBILITY_FILES);
      const files = Object.fromEntries(runtimeFiles.map((path) => [path, digest(readFileSync(join(outputRoot, path)))]));
      const applicationCapabilityDigest=files[CUSTODY_APPLICATION_CAPABILITY_PATH];
      const custodyApplicationProvenance:CustodyApplicationProvenance|undefined=applicationCapabilityDigest?{
        format:1,applicationSourceTreeDigest:sourceTreeDigest,applicationCapabilityDigest}:undefined;
      const unsigned = {
        format: 2 as const,
        git_commit: gitCommit,
        control_git_commit: controlGitCommit,
        source_tree_digest: sourceTreeDigest,
        control_source_tree_digest: controlSourceTreeDigest,
        runtime_digest: runtimeDigest,
        compatibility_digest: compatibilityDigest,
        files,
        ...(applicationPaths.size?{application_bundle_source_digest:sourceTreeDigest}:{}),
        ...(custodyApplicationProvenance?{custody_application_provenance:custodyApplicationProvenance}:{}),
      };
      const artifactDigest = digest(JSON.stringify(unsigned));
      const manifest: ReleaseManifest = { ...unsigned, artifact_digest: artifactDigest };
      writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
      const artifactPath = join(this.environment.releaseRoot, "releases", artifactDigest);
      mkdirSync(dirname(artifactPath), { recursive: true, mode: 0o755 });
      if (existsSync(artifactPath)) {
        const existing = this.verify(artifactPath);
        if (existing.git_commit !== gitCommit
          || existing.control_git_commit !== controlGitCommit
          || existing.source_tree_digest !== sourceTreeDigest
          || existing.control_source_tree_digest !== controlSourceTreeDigest) {
          throw new Error("Existing release digest does not match the prepared source.");
        }
        // Reused by a new attempt, so it counts as newly prepared for release retention.
        const now = new Date();
        utimesSync(artifactPath, now, now);
      } else {
        // Linux needs directory write permission to change its parent. Move the
        // writable candidate beside its final name first; seal before the
        // same-parent atomic publication. A failed unpublished candidate stays
        // retained, never made writable at a published artifact's path.
        const unpublishedPath=join(dirname(artifactPath),`.preparing-${randomUUID()}`);
        renameSync(outputRoot,unpublishedPath);
        makeReadOnly(unpublishedPath);
        renameSync(unpublishedPath, artifactPath);
      }
      return { artifactPath, manifest: this.verify(artifactPath) };
    } finally {
      if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  verify(artifactPath: string): ReleaseManifest {
    const canonical = realpathSync(artifactPath);
    assertInside(join(this.environment.releaseRoot, "releases"), canonical);
    // Checked against the file list sealed in its own manifest, not against this code's current
    // list: a release stays valid when later code adds or removes files. The manifest cannot be
    // altered without changing its digest, which is also the directory's name.
    const manifest = JSON.parse(readFileSync(join(canonical, "manifest.json"), "utf8")) as ReleaseManifest;
    if (manifest.format !== 2) throw new Error("Release manifest format is unsupported.");
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
      throw new Error("Release manifest has no file list.");
    }
    const sealedFiles = Object.keys(manifest.files).sort();
    for (const path of sealedFiles) {
      if (path === "manifest.json" || path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error(`Release manifest lists an unsafe path ${path}.`);
      }
    }
    for (const path of LAUNCHER_ENTRYPOINTS) {
      if (!sealedFiles.includes(path)) throw new Error(`Release is missing launcher entrypoint ${path}.`);
    }
    const files = listRegularFiles(canonical);
    const expectedFiles = [...sealedFiles, "manifest.json"].sort();
    if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
      throw new Error(`Release artifact file set does not match its manifest: ${files.join(", ")}`);
    }
    assertCommit(manifest.git_commit);
    assertCommit(manifest.control_git_commit);
    for (const [value, label] of [
      [manifest.source_tree_digest, "source tree digest"],
      [manifest.control_source_tree_digest, "control source tree digest"],
      [manifest.runtime_digest, "runtime digest"],
      [manifest.compatibility_digest, "compatibility digest"],
      [manifest.artifact_digest, "artifact digest"],
    ] as Array<[unknown, string]>) assertDigest(value, label);
    for (const path of sealedFiles) {
      assertDigest(manifest.files[path], `file digest for ${path}`);
      if (digest(readFileSync(join(canonical, path))) !== manifest.files[path]) {
        throw new Error(`Release file digest is invalid for ${path}.`);
      }
    }
    if (releaseFileSetDigest(canonical, sealedFiles) !== manifest.runtime_digest) {
      throw new Error("Release runtime digest is invalid.");
    }
    const { artifact_digest: _artifactDigest, ...unsigned } = manifest;
    if (digest(JSON.stringify(unsigned)) !== manifest.artifact_digest) {
      throw new Error("Release manifest digest is invalid.");
    }
    if (canonical !== join(this.environment.releaseRoot, "releases", manifest.artifact_digest)) {
      throw new Error("Release directory name does not match its manifest digest.");
    }
    return manifest;
  }

  currentArtifactPath(): string | null {
    const current = join(this.environment.releaseRoot, "current");
    if (!existsSync(current)) return null;
    if (!lstatSync(current).isSymbolicLink()) throw new Error("Stable release pointer is not a symlink.");
    const path = resolve(this.environment.releaseRoot, readlinkSync(current));
    this.verify(path);
    return realpathSync(path);
  }

  controlArtifactPath(): string | null {
    const control = join(this.environment.releaseRoot, "control");
    if (!existsSync(control)) return null;
    if (!lstatSync(control).isSymbolicLink()) throw new Error("Stable control pointer is not a symlink.");
    const path = resolve(this.environment.releaseRoot, readlinkSync(control));
    this.verify(path);
    return realpathSync(path);
  }

  activateControl(artifactPath: string) {
    const canonical = realpathSync(artifactPath);
    const manifest = this.verifyControlActivation(canonical);
    mkdirSync(this.environment.releaseRoot, { recursive: true, mode: 0o755 });
    this.installRuntimeLaunchers();
    const temporary = join(this.environment.releaseRoot, `.control-${randomUUID()}`);
    symlinkSync(relative(this.environment.releaseRoot, canonical), temporary);
    renameSync(temporary, join(this.environment.releaseRoot, "control"));
    const proven = this.controlArtifactPath();
    if (proven !== canonical) throw new Error("Stable control pointer did not activate the requested artifact.");
    return manifest;
  }

  activate(artifactPath: string) {
    const canonical = realpathSync(artifactPath);
    const manifest = this.verify(canonical);
    if(this.environment.historyCacheStateDirectory)
      assertHistoryCacheActivation(this.environment.historyCacheStateDirectory,canonical,manifest.files);
    this.assertCustodyReader(canonical,manifest,false);
    mkdirSync(this.environment.releaseRoot, { recursive: true, mode: 0o755 });
    const temporary = join(this.environment.releaseRoot, `.current-${randomUUID()}`);
    symlinkSync(relative(this.environment.releaseRoot, canonical), temporary);
    renameSync(temporary, join(this.environment.releaseRoot, "current"));
    const proven = this.currentArtifactPath();
    if (proven !== canonical) throw new Error("Stable release pointer did not activate the requested artifact.");
    return manifest;
  }

  restore(artifactPath: string) {
    this.verifyRuntimeLaunchers(realpathSync(artifactPath));
    {
      const canonical=realpathSync(artifactPath),manifest=this.verify(canonical);
      if(this.environment.historyCacheStateDirectory)
      assertHistoryCacheActivation(this.environment.historyCacheStateDirectory,canonical,manifest.files,true);
      this.assertCustodyReader(canonical,manifest,true);
    }
    const manifest = this.activate(artifactPath);
    this.activateControl(artifactPath);
    return manifest;
  }

  /**
   * Removes sealed releases nothing can still run. Every successful update used to leave its
   * artifact behind forever: 767 of them (9.8 GB) on 2026-11-04 with the root filesystem at 89%.
   * Kept: the current and control pointers, the paths the ledger still names (the last-known-good
   * rollback and the host scripts of executions not yet released), the newest releases by
   * preparation time, and any release a live process or systemd unit names, because agent
   * execution hosts keep running from the release that launched them across later updates.
   * Removal renames first, so an interrupted prune never leaves a half-deleted release under a
   * digest name; leftovers from an interrupted prune are finished on the next one.
   */
  pruneReleases(ledgerReferences: string[], recent = RETAINED_RECENT_RELEASES) {
    return withLaunchSelection(()=>{
    const releases = join(this.environment.releaseRoot, "releases");
    const named = readdirSync(releases).filter(name => /^[0-9a-f]{64}$/.test(name));
    const kept = new Set<string>(named.map(name => ({ name, at: lstatSync(join(releases, name)).mtimeMs }))
      .sort((left, right) => right.at - left.at).slice(0, recent).map(release => release.name));
    for (const path of [this.currentArtifactPath(), this.controlArtifactPath()]) {
      if (path) kept.add(basename(path));
    }
    const releasePath = releaseDigestPattern(this.environment.releaseRoot);
    for (const reference of ledgerReferences) for (const match of reference.matchAll(releasePath)) kept.add(match[1]!);
    for (const reference of launchAuthorityReferences(join(this.environment.releaseRoot,'launch-authority'))) for(const match of reference.matchAll(releasePath))kept.add(match[1]!);
    const engines=join(this.environment.installRoot,'engines');
    const liveReferences=releasesNamedByProcessesAndUnits(this.environment.releaseRoot,{additionalRoots:[engines],referenceFiles:[
      ...['bun','control','launch'].map(name=>join(this.environment.installRoot,name)),
      join(process.env.CONCIERGE_CAPTURE_RUNTIME_DIR??'/usr/local/lib/slack-concierge','bun')]});
    for (const digest of liveReferences) kept.add(digest);
    const removed: string[] = [];
    for (const name of named) {
      if (kept.has(name)) continue;
      const retiring = join(releases, `.pruning-${name}`);
      renameSync(join(releases, name), retiring);
      removed.push(name);
    }
    for (const name of readdirSync(releases)) {
      if (name.startsWith(".pruning-")) rmSync(join(releases, name), { recursive: true, force: true });
    }
    const enginesRemoved:string[]=[];
    if(existsSync(engines))for(const name of readdirSync(engines)){
      if(!/^[a-f0-9]{64}$/.test(name)||liveReferences.has(name))continue;
      const directory=join(engines,name),binary=join(directory,'bun');
      if(!lstatSync(directory).isDirectory()||JSON.stringify(readdirSync(directory))!==JSON.stringify(['bun'])
        ||!lstatSync(binary).isFile()||lstatSync(binary).mode&0o222||digest(readFileSync(binary))!==name)
        throw Error('Unrecognized installed engine files; nothing in that directory was retired.');
      const retiring=join(engines,'.pruning-'+name);renameSync(directory,retiring);
      rmSync(join(retiring,'bun'));rmdirSync(retiring);enginesRemoved.push(name);
    }
    return { kept: [...kept].filter(name => named.includes(name)).sort(), removed,enginesRemoved };
    },join(this.environment.releaseRoot,'launch-authority'));
  }
}

// About 25 releases are prepared on a busy day; twenty keeps most of a day (the release before
// the one just promoted, failed candidates, a few rollbacks by hand) at about 13 MB each.
const RETAINED_RECENT_RELEASES = 20;
const UNIT_DIRECTORIES = ["/run/systemd/transient", "/run/systemd/system", "/etc/systemd/system"];

/**
 * Release digests any running process or installed unit names by path: in its command line,
 * environment, working directory, executable, open files or memory maps. A process that ends
 * mid-scan is skipped; any other failure to read throws, because "could not look" must never pass
 * for "nothing uses it".
 */
export function releasesNamedByProcessesAndUnits(releaseRoot: string,options:{additionalRoots?:string[];referenceFiles?:string[]}={}): Set<string> {
  const roots=[join(releaseRoot,'releases'),...(options.additionalRoots??[])];
  const pattern = new RegExp(`(?:${roots.map(path=>path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})/([0-9a-f]{64})(?:/|\\b)`,'g');
  const found = new Set<string>();
  const collect = (text: string) => { for (const match of text.matchAll(pattern)) found.add(match[1]!); };
  const referenceFiles=new Set(options.referenceFiles??[]);
  const collectWrapper=(path:string)=>{
    const fd=openSync(path,'r');let owned=false;
    try{const header=Buffer.alloc(RUNTIME_DISPATCH_HEADER.length);readSync(fd,header,0,header.length,0);owned=header.toString()===RUNTIME_DISPATCH_HEADER;}
    finally{closeSync(fd);}
    if(owned)collect(readFileSync(path,'utf8'));
  };
  const gone = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const proc = `/proc/${entry}`;
    try {
      collect(readFileSync(`${proc}/cmdline`, "utf8"));
      collect(readFileSync(`${proc}/environ`, "utf8"));
      collect(readFileSync(`${proc}/maps`, "utf8"));
      for (const link of ["cwd", "exe"]) {
        try { collect(readlinkSync(`${proc}/${link}`)); } catch (error) { if (!gone(error)) throw error; }
      }
      for (const fd of readdirSync(`${proc}/fd`)) {
        try {
          const path=`${proc}/fd/${fd}`,target=readlinkSync(path);collect(target);
          if(referenceFiles.has(target.replace(/ \(deleted\)$/,'')))collectWrapper(path);
        } catch (error) { if (!gone(error)) throw error; }
      }
    } catch (error) {
      if (!gone(error)) throw error;
    }
  }
  for(const path of referenceFiles)if(existsSync(path))collectWrapper(path);
  for (const directory of UNIT_DIRECTORIES) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      try { if (lstatSync(path).isFile()) collect(readFileSync(path, "utf8")); } catch (error) { if (!gone(error)) throw error; }
    }
  }
  return found;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const releaseDigestPattern = (releaseRoot: string) =>
  new RegExp(`${escapeRegExp(join(releaseRoot, "releases"))}/([0-9a-f]{64})`, "g");
