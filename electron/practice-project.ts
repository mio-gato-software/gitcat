import { randomUUID } from 'node:crypto';
import { appendFileSync, constants, existsSync, fstatSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { PracticeInfo } from '../shared/types.js';

type Owned = PracticeInfo & { token:string };
export class PracticeProjects {
 constructor(private root:string, private git:(cwd:string,args:string[])=>Promise<string>) {}
 private registry(){return join(this.root,'projects.json');}
 private read():Owned[]{
  if(!existsSync(this.registry()))return [];
  const value=JSON.parse(readFileSync(this.registry(),'utf8'));
  if(!Array.isArray(value))throw new Error('Practice registry could not be read.');
  // Older Windows records can contain 8.3 aliases. Keep missing projects registered,
  // but compare existing paths in the same native form that Git returns.
  return value.map((record:Owned)=>{try{return {...record,path:realpathSync.native(record.path)};}catch{return record;}});
 }
 private write(value:Owned[]){mkdirSync(this.root,{recursive:true});const temporary=this.registry()+'.tmp';writeFileSync(temporary,JSON.stringify(value),{mode:0o600});renameSync(temporary,this.registry());}
 registered(path:string):boolean {try{return this.read().some(record=>record.path===resolve(path)||record.path===realpathSync.native(path));}catch{return false;}}
 owns(path:string):boolean {
  try {
   const root=realpathSync.native(this.root),canonical=realpathSync.native(path),record=this.read().find(r=>r.path===canonical);
   if(!record||lstatSync(path).isSymbolicLink()||dirname(canonical)!==root||!/^practice-[a-f0-9-]{36}$/.test(basename(canonical)))return false;
   const marker=join(canonical,'.gitcat-practice.json');
   if(lstatSync(marker).isSymbolicLink()||!lstatSync(join(canonical,'.git')).isDirectory()||lstatSync(join(canonical,'.git')).isSymbolicLink())return false;
   const proof=JSON.parse(readFileSync(marker,'utf8'));
   return proof.token===record.token && proof.id===record.id;
  }catch{return false;}
 }
 info(path:string):PracticeInfo|null {if(!this.owns(path))return null;const record=this.read().find(r=>r.path===realpathSync.native(path))!;return {id:record.id,path:record.path,lesson:record.lesson};}
 private owned(path:string){if(!this.owns(path))throw new Error('This folder is not a verified GitCat practice project. Nothing was changed.');return realpathSync.native(path);}
 async create():Promise<PracticeInfo>{
  mkdirSync(this.root,{recursive:true});const root=realpathSync.native(this.root),id=randomUUID(),path=join(root,`practice-${id}`),token=randomUUID();
  mkdirSync(path);const templates=join(path,'.empty-templates');mkdirSync(templates);
  await this.git(path,['init','-q','-b','main',`--template=${templates}`]);rmSync(templates,{recursive:true});
  for(const [key,value] of [['user.name','GitCat Practice'],['user.email','practice@example.invalid'],['commit.gpgSign','false'],['tag.gpgSign','false'],['core.hooksPath',join(path,'.git','disabled-hooks')],['credential.helper','']])await this.git(path,['config','--local',key,value]);
  writeFileSync(join(path,'.gitcat-practice.json'),JSON.stringify({id,token}),{mode:0o600});
  mkdirSync(join(path,'.git','info'),{recursive:true});
  writeFileSync(join(path,'.git','info','exclude'),'.gitcat-practice.json\n');
  writeFileSync(join(path,'README.md'),'# Disposable GitCat practice\n\nThis project is isolated and has no remote. A commit is a local saved version; a branch is a line of work. Publishing would send saved versions to a remote, and is disabled here.\n');
  writeFileSync(join(path,'story.txt'),'Once upon a time, I learned to save my work.\n');
  writeFileSync(join(path,'conflict.txt'),'Choose a greeting.\n');
  await this.git(path,['add','README.md','story.txt','conflict.txt']);await this.git(path,['commit','-qm','Start a disposable practice project']);
  await this.git(path,['switch','-qc','practice/conflict-theirs']);writeFileSync(join(path,'conflict.txt'),'Hello from the other branch.\n');await this.git(path,['commit','-qam','Example: greeting from the other branch']);
  await this.git(path,['switch','-qc','practice/conflict-ours','main']);writeFileSync(join(path,'conflict.txt'),'Hello from your branch.\n');await this.git(path,['commit','-qam','Example: greeting from your branch']);
  await this.git(path,['switch','-q','main']);
  const record={id,path,token,lesson:0};this.write([...this.read(),record]);return {id,path,lesson:0};
 }
 lesson(path:string,lesson:number):PracticeInfo {
  const canonical=this.owned(path);if(!Number.isInteger(lesson)||lesson<0||lesson>5)throw new Error('Invalid lesson');
  const records=this.read(),record=records.find(r=>r.path===canonical)!;record.lesson=lesson;this.write(records);return {id:record.id,path:record.path,lesson};
 }
 edit(path:string){
  const canonical=this.owned(path),file=join(canonical,'story.txt');
  const fd=openSync(file,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);
  try {const stat=fstatSync(fd);if(!stat.isFile()||stat.size>64000)throw new Error('The sample file was replaced or is too large. Review it before editing.');appendFileSync(fd,`A new practice idea at ${new Date().toISOString()}.\n`);}finally{closeSync(fd);}
 }
 remove(path:string){const canonical=this.owned(path);if(resolve(canonical)===resolve(this.root))throw new Error('Cannot remove the practice root.');rmSync(canonical,{recursive:true});this.write(this.read().filter(r=>r.path!==canonical));}
}
