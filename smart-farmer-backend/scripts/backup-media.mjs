import {cp,lstat,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';

export async function copyIntoEmptyMediaDirectory(source,destination){
  await mkdir(destination,{recursive:true,mode:0o700});
  const info=await lstat(destination);
  if(!info.isDirectory()||info.isSymbolicLink()||(await readdir(destination)).length)throw new Error('Restore media directory must be empty');
  // Node rejects copying a directory onto an existing directory when
  // errorOnExist is true. Keep that protection on each new child instead.
  for(const name of await readdir(source)){
    await cp(join(source,name),join(destination,name),{recursive:true,errorOnExist:true,force:false});
  }
}
