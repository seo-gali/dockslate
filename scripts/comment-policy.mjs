import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const extensions=new Set(['.ts','.tsx','.cts','.mts','.js','.jsx','.cjs','.mjs','.rs','.css','.html','.svg','.ps1','.nsh','.sh','.py','.yaml','.yml','.toml']);
export const inCommentScope=file=>!file.startsWith('licenses/')&&!file.startsWith('downloads/')&&!file.startsWith('docs/')&&(extensions.has(path.extname(file))||['.gitignore','.gitattributes','Dockerfile'].includes(path.basename(file)));
export function commentFiles(root){return [...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8',windowsHide:true}).split('\0').filter(file=>file&&inCommentScope(file)&&fs.existsSync(path.join(root,file))))].sort();}
const digest=text=>createHash('sha256').update(text).digest('hex');

function scriptComments(file,text){
 const kind=path.extname(file),ps=kind==='.ps1',shell=kind==='.sh',nsis=kind==='.nsh',python=kind==='.py';
 const rows=[];let i=0,heredocs=[];
 const add=(start,end)=>rows.push({start,end});
 function quoted(quote,triple=false){
  const end=triple?quote.repeat(3):quote;i+=end.length;
  while(i<text.length){
   if(text[i]==='`'&&ps&&quote==='"'){i+=2;continue;}
   if(text[i]==='\\'&&!ps&&(quote!=="'"||python)){i+=2;continue;}
   if(ps&&quote==='"'&&text.slice(i,i+2)==='$('){i+=2;code(')');continue;}
   if(text.startsWith(end,i)){
    if(ps&&!triple&&text[i+1]===quote){i+=2;continue;}
    if(nsis&&text[i-1]==='$'){i++;continue;}
    i+=end.length;return;
   }
   i++;
  }
 }
 function code(until=''){
  while(i<text.length){
   if(until&&text[i]===until){i++;return;}
   if(ps&&text[i]==='('){i++;code(')');continue;}
   if(ps&&text.startsWith('<#',i)){
    const start=i;let depth=1;i+=2;
    while(i<text.length&&depth){if(text.startsWith('<#',i)){depth++;i+=2;}else if(text.startsWith('#>',i)){depth--;i+=2;}else i++;}
    add(start,i);continue;
   }
   if(ps&&/^@["']\r?\n/.test(text.slice(i))){
    const quote=text[i+1],start=i+2,match=new RegExp('^'+quote+'@(?=\\r?$)','m').exec(text.slice(start));
    const end=match?start+match.index:text.length;
    i=start;
    if(quote==='"'){while(i<end){if(text[i]==='`'){i+=2;}else if(text.slice(i,i+2)==='$('){i+=2;code(')');}else i++;}}
    i=match?end+2:text.length;continue;
   }
   if(shell&&text.startsWith('<<',i)){
    const match=/^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([\w]+))/.exec(text.slice(i));
    if(match){heredocs.push({word:match[2]??match[3]??match[4],tabs:!!match[1]});i+=match[0].length;continue;}
   }
   if(text[i]==='\n'&&shell&&heredocs.length){
    i++;
    for(const doc of heredocs){while(i<text.length){const end=text.indexOf('\n',i),line=text.slice(i,end<0?text.length:end).replace(/\r$/,'');i=end<0?text.length:end+1;if((doc.tabs?line.replace(/^\t+/,''):line)===doc.word)break;}}
    heredocs=[];continue;
   }
   if((ps&&text[i]==='`')||(!ps&&text[i]==='\\')){i+=2;continue;}
   if(text[i]==='"'||text[i]==="'"){const quote=text[i];quoted(quote,python&&text.startsWith(quote.repeat(3),i));continue;}
   const hash=text[i]==='#'&&(!shell||i===0||/[\s;|&()]/.test(text[i-1]));
   if(hash||(nsis&&text[i]===';')){const start=i,end=text.indexOf('\n',i);i=end<0?text.length:end;add(start,i);continue;}
   i++;
  }
 }
 code();return rows;
}

function slashComments(text,rust=false,lineComments=true){
 const rows=[];let i=0;
 while(i<text.length){
  if(rust){const raw=/^(?:b|c)?r(#{0,255})"/.exec(text.slice(i));if(raw&&(i===0||!/[\w]/.test(text[i-1]))){const end=text.indexOf('"'+raw[1],i+raw[0].length);i=end<0?text.length:end+raw[1].length+1;continue;}}
  if(text[i]==='"'||(!rust&&text[i]==="'")){const quote=text[i++];while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i++]===quote)break;}continue;}
  if(rust&&text[i]==="'"){const char=/^'(?:\\u\{[\da-fA-F_]+\}|\\x[\da-fA-F]{2}|\\.|[^'\\\r\n])'/u.exec(text.slice(i));if(char){i+=char[0].length;continue;}}
  if(lineComments&&text.startsWith('//',i)){const start=i,end=text.indexOf('\n',i);i=end<0?text.length:end;rows.push({start,end:i});continue;}
  if(text.startsWith('/*',i)){const start=i;let depth=1;i+=2;while(i<text.length&&depth){if(rust&&text.startsWith('/*',i)){depth++;i+=2;}else if(text.startsWith('*/',i)){depth--;i+=2;}else i++;}rows.push({start,end:i});continue;}
  i++;
 }
 return rows;
}

function typescriptComments(file,text){
 const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,file.endsWith('x')?ts.ScriptKind.TSX:ts.ScriptKind.TS),ranges=new Map(),literals=[];
 const protectedKinds=new Set([ts.SyntaxKind.StringLiteral,ts.SyntaxKind.RegularExpressionLiteral,ts.SyntaxKind.NoSubstitutionTemplateLiteral,ts.SyntaxKind.TemplateHead,ts.SyntaxKind.TemplateMiddle,ts.SyntaxKind.TemplateTail,ts.SyntaxKind.JsxText]);
 function visit(node){
  if(protectedKinds.has(node.kind))literals.push([node.kind===ts.SyntaxKind.JsxText?node.pos:node.getStart(source),node.end]);
  for(const range of [...ts.getLeadingCommentRanges(text,node.pos)??[],...ts.getTrailingCommentRanges(text,node.end)??[]])ranges.set(range.pos,{start:range.pos,end:range.end});
  for(const child of node.getChildren(source))visit(child);
 }
 visit(source);
 return [...ranges.values()].filter(r=>!literals.some(([start,end])=>r.start>=start&&r.start<end));
}

function htmlComments(text){
 const ranges=[];let i=0;
 while(i<text.length){
  if(text.startsWith('<!--',i)){const end=text.indexOf('-->',i+4);ranges.push({start:i,end:end<0?text.length:end+3});i=ranges.at(-1).end;continue;}
  const raw=/^<(script|style)\b[^>]*>/i.exec(text.slice(i));
  if(raw){const start=i+raw[0].length,close=new RegExp('</'+raw[1]+'\\s*>','ig');close.lastIndex=start;const match=close.exec(text),end=match?match.index:text.length;const body=text.slice(start,end),inner=raw[1].toLowerCase()==='script'?typescriptComments('inline.js',body):slashComments(body,false,false);ranges.push(...inner.map(r=>({start:r.start+start,end:r.end+start})));i=match?close.lastIndex:end;continue;}
  if(text[i]==='<'){i++;while(i<text.length&&text[i]!=='>'){if(text[i]==='"'||text[i]==="'"){const quote=text[i++];while(i<text.length&&text[i]!==quote)i++;}i++;}i++;continue;}
  i++;
 }
 return ranges;
}

function configComments(file,text){
 const rows=[],toml=path.extname(file)==='.toml';let offset=0,blockIndent=null,quote='';
 for(const line of text.split('\n')){
  const indent=line.match(/^\s*/)[0].length;
  if(blockIndent!==null&&(!line.trim()||indent>blockIndent)){offset+=line.length+1;continue;}blockIndent=null;
  for(let i=0;i<line.length;i++){
   if(quote){
    if(line[i]==='\\'&&quote[0]==='"')i++;
    else if(line.startsWith(quote,i)){
     if(!toml&&quote==="'"&&line[i+1]===quote)i++;
     else {i+=quote.length-1;quote='';}
    }
    continue;
   }
   if(line[i]==='"'||line[i]==="'"){quote=toml&&line.startsWith(line[i].repeat(3),i)?line[i].repeat(3):line[i];i+=quote.length-1;continue;}
   if(line[i]==='#'&&(toml||i===0||/\s/.test(line[i-1]))){rows.push({start:offset+i,end:offset+line.length});break;}
  }
  if(/\.ya?ml$/.test(file)&&/:\s*[|>][+-]?\s*$/.test(line))blockIndent=indent;
  offset+=line.length+1;
 }
 return rows;
}

export function scanComments(file,text){
 const extension=path.extname(file);let ranges;
 if(/\.[cm]?[jt]sx?$/.test(file))ranges=typescriptComments(file,text);
 else if(extension==='.rs')ranges=slashComments(text,true);
 else if(extension==='.css')ranges=slashComments(text,false,false);
 else if(extension==='.html'||extension==='.svg')ranges=htmlComments(text);
 else if(['.ps1','.sh','.py','.nsh'].includes(extension))ranges=scriptComments(file,text);
 else if(['.gitignore','.gitattributes','Dockerfile'].includes(path.basename(file))){ranges=[];let offset=0;for(const line of text.split('\n')){if(/^\s*#/.test(line))ranges.push({start:offset+line.indexOf('#'),end:offset+line.length});offset+=line.length+1;}}
 else ranges=configComments(file,text);
 return ranges.sort((a,b)=>a.start-b.start).map(({start,end})=>{const body=text.slice(start,end).replace(/\r$/,'');end=start+body.length;const before=text.slice(0,start),line=before.split('\n').length,column=start-(text.lastIndexOf('\n',start-1)+1)+1;const next=text.slice(end).trimStart().split(/\r?\n/,1)[0].trim();return {file,line,column,start,end,text:body,id:digest(file+'\0'+body+'\0'+next)};});
}

export function compareBaseline(comments,baseline){
 const available=new Map(baseline.entries.map(e=>[e.id,e.count]));const added=[];
 for(const comment of comments){const left=available.get(comment.id)??0;if(!left)added.push(comment);else available.set(comment.id,left-1);}
 return {added,removed:[...available.values()].reduce((a,b)=>a+b,0)};
}
