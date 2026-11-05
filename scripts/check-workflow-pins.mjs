import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const root=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const pinned=reference=>/^[-\w.]+\/[-\w.]+(?:\/[-\w./]+)?@[a-f\d]{40}$/i.test(reference)
  || /^docker:\/\/[-\w.:/]+@sha256:[a-f\d]{64}$/i.test(reference)
  || (reference.startsWith('./')&&/^\.\/[-\w./]+$/.test(reference)&&!reference.slice(2).split('/').includes('..'));

// Quotes/comments and run/description blocks are data, not action references.
function lineParts(line){
  let quote='',code='',plain='';
  for(let i=0;i<line.length;i++){
    const char=line[i];
    if(quote){
      code+=char;plain+=' ';
      if(quote==='"'&&char==='\\'&&i+1<line.length){code+=line[++i];plain+=' ';}
      else if(char===quote){if(quote==="'"&&line[i+1]==="'"){code+=line[++i];plain+=' ';}else quote='';}
    }else if(char==='#'&&(i===0||/\s/.test(line[i-1])))break;
    else if((char==='"'||char==="'")&&(i===0||/[\s:[{,\-]/.test(line[i-1]))){quote=char;code+=char;plain+=' ';}
    else {code+=char;plain+=char;}
  }
  return {code:code.trimEnd(),plain:plain.replace(/\$\{\{.*?\}\}/g,''),unclosed:!!quote};
}

function inspect(source){
  const errors=[],references=[];
  let blockIndent=null,square=0;
  for(const [index,line] of source.split(/\r?\n/).entries()){
    if(!line.trim())continue;
    const indent=line.match(/^ */)[0].length;
    if(blockIndent!==null){if(indent>blockIndent)continue;blockIndent=null;}
    const {code,plain,unclosed}=lineParts(line);if(!code.trim())continue;
    const fail=message=>errors.push({line:index+1,message});
    if(/^ *\t/.test(line)||unclosed)fail('Use spaces and single-line quoted scalars or block scalars.');
    if(/^\s*(?:-\s+)?[?*!&]/.test(plain)||/"(?:[^"\\]|\\.)*\\(?:[^"\\]|\\.)*"\s*:/.test(code))fail('Use literal mapping keys; escaped keys and alias keys are not supported.');
    for(let i=0;i<plain.length;i++){
      if(plain[i]==='{'||plain[i]==='}'||(square>0&&plain[i]===':'&&/\s/.test(plain[i+1]??'')))fail('Use block mappings instead of inline mappings.');
      if(plain[i]==='[')square++;else if(plain[i]===']')square--;
    }
    const property=code.match(/^( *)(- +)?(?:([\w-]+)|'([^']*)'|"([^"\\]*)")\s*:\s*(.*)$/);
    const key=property&&(property[3]??property[4]??property[5]);
    if(key==='uses'){
      const value=property[6].match(/^(?:'([^']*)'|"([^"\\]*)"|([^\s'"\[\]{}]+))$/);
      const reference=value&&(value[1]??value[2]??value[3]);
      if(!reference||!pinned(reference))fail('External uses must use a full 40-character commit SHA (Docker: sha256 digest); use a one-line literal.');
      else references.push({line:index+1,reference});
    }else if(/\buses\s*:/.test(plain))fail('Write uses as its own literal block-mapping entry.');
    if(property&&/^[|>]/.test(property[6])){
      if(!/^[|>][+-]?$/.test(property[6]))fail('Use a block scalar without an explicit indentation indicator.');
      blockIndent=property[1].length+(property[2]?.length??0);
    }
  }
  return {errors,references};
}

const sha='a'.repeat(40),digest='b'.repeat(64);
const examples=[
  [`- uses: actions/checkout@${sha} # v6`,true],
  [`uses: 'owner/repo/path/action@${sha}'`,true],
  [`"uses": "owner/repo/.github/workflows/build.yml@${sha}"`,true],
  ['uses: ./local-action',true],['uses: ./../outside',false],
  [`uses: docker://alpine@sha256:${digest}`,true],['uses: docker://alpine:latest',false],
  ['uses: owner/repo@v3',false],['uses: owner/repo@main',false],['uses: owner/repo@abcdef0',false],
  [`uses: owner/repo@${sha}a`,false],['uses: ${{ matrix.action }}',false],
  ['uses: *action',false],['uses: &action owner/repo@v3',false],
  ['uses: >-\n  owner/repo@v3',false],['steps: [{uses: owner/repo@v3}]',false],
  ['steps: ["uses": owner/repo@v3]',false],['"u\\u0073es": owner/repo@v3',false],
  ['? uses\n: owner/repo@v3',false],['"us\n  es": owner/repo@v3',false],
  ['# uses: owner/repo@v3\nrun: |\n  echo "uses: owner/repo@v3"',true],
  [`- name: |\n    Description\n  uses: owner/repo@${sha}`,true],
  ['- name: |\n    Description\n  uses: owner/repo@v3',false],
  ['env:\n  TOKEN: ${{ github.token }}\non: [push, pull_request]',true],
  ["name: Don't deploy\nrun: echo 'uses: data'",true],
];
for(const [source,allowed] of examples)assert.equal(inspect(source).errors.length===0,allowed,source);

const directory=path.join(root,'.github/workflows');
const queue=fs.readdirSync(directory).filter(name=>/\.ya?ml$/.test(name)).map(name=>path.join(directory,name));
const seen=new Set(),errors=[];let references=0;
while(queue.length){
  const file=queue.shift(),physical=fs.realpathSync(file),relative=path.relative(root,file).replaceAll('\\','/');
  const inside=path.relative(root,physical);if(inside.startsWith('..')||path.isAbsolute(inside))throw Error('Action metadata must stay in the repository.');
  if(seen.has(physical))continue;seen.add(physical);
  const result=inspect(fs.readFileSync(file,'utf8'));references+=result.references.length;
  errors.push(...result.errors.map(error=>`${relative}:${error.line}: ${error.message}`));
  for(const {reference,line} of result.references){
    if(!reference.startsWith('./'))continue;
    const local=path.resolve(root,reference);
    const candidates=/\.ya?ml$/.test(local)?[local]:[path.join(local,'action.yml'),path.join(local,'action.yaml')];
    const metadata=candidates.find(candidate=>fs.existsSync(candidate));
    if(metadata)queue.push(metadata);else errors.push(`${relative}:${line}: Referenced local action/workflow metadata is missing.`);
  }
}
for(const error of errors)console.error(error);
console.log(JSON.stringify({files:seen.size,references,selfChecks:examples.length,errors:errors.length}));
if(errors.length)process.exitCode=1;
