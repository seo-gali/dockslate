import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2), write = args.includes('--write'), list = args.includes('--list'), allList = args.includes('--all-list');
const requested = args.filter(value => !value.startsWith('--'));
const root = process.cwd(), sourceRoot = path.join(root, 'src');
const englishLabels = new Set(['Image','Internal','Overview','Containers','Images','Volumes','Resources','Networks','Builds','Disk Manager','Settings','All','Running','Stopped','Connected','Disconnected','Size','Created','Type','Repository / Tag','Build cache','Docker Usage','WSL Disks','Pull image','Stars','Official','Mounts','Terminal','Files','Stats','Logs','Inspect']);
const attributes = new Set(['title','aria-label','placeholder','description']);
const templatePatterns = new Set(['{} 작업','{} 이미지 선택','{} 선택','{} 삭제','{} 컨테이너 실행','{} 볼륨 삭제 확인','{} 조회','{}개에서 참조','최근 앱 빌드 {}','승인 만료: {}']);
const eligible = value => /[가-힣]/u.test(value) || englishLabels.has(value.trim());
const files = [];
function discover(directory) { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const value=path.join(directory,item.name); if(item.isSymbolicLink())continue;if(item.isDirectory())discover(value);else if(/\.tsx$/.test(item.name))files.push(value); } }
if(requested.length)for(const value of requested){const absolute=path.resolve(value),relative=path.relative(sourceRoot,absolute),real=path.relative(fs.realpathSync(sourceRoot),fs.realpathSync(absolute));if(relative.startsWith('..')||path.isAbsolute(relative)||real.startsWith('..')||path.isAbsolute(real)||fs.lstatSync(absolute).isSymbolicLink()||!absolute.endsWith('.tsx'))throw Error('Only plain src/*.tsx files are allowed');files.push(absolute);}else discover(sourceRoot);
const messages = new Set(), reviewMessages = new Set(), remaining = [], summary=[];
function decodeText(raw) {
  const result = ts.transpileModule(`const text=<span>${raw}</span>;`, {compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;
  const parsed=ts.createSourceFile('text.js',result,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let value=null;
  const visit=node=>{if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='createElement'&&node.arguments.length===3&&ts.isStringLiteral(node.arguments[2]))value=node.arguments[2].text;ts.forEachChild(node,visit);};visit(parsed);return value;
}
for(const filename of files.sort()) {
  const source=fs.readFileSync(filename,'utf8'), sf=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX), edits=[], before=new Set(), unsafe=[];
  if(sf.parseDiagnostics.length)throw Error(`Invalid source: ${path.relative(root,filename)}`);
  const record=(value,kind,node)=>{messages.add(value);before.add(value);edits.push({start:node.getStart(sf),end:node.end,text:kind==='attribute'?`{t(${JSON.stringify(value)})}`:`t(${JSON.stringify(value)})`});};
  const inline=node=>{
    if((ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))&&eligible(node.text)){messages.add(node.text);before.add(node.text);return `t(${JSON.stringify(node.text)})`;}
    if(ts.isConditionalExpression(node))return `(${node.condition.getText(sf)} ? ${inline(node.whenTrue)} : ${inline(node.whenFalse)})`;
    if(ts.isParenthesizedExpression(node))return `(${inline(node.expression)})`;
    return node.getText(sf);
  };
  const safeExpression=node=>{
    if(!node)return;
    if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)){if(eligible(node.text))record(node.text,'expression',node);return;}
    if(ts.isParenthesizedExpression(node)){safeExpression(node.expression);return;}
    if(ts.isConditionalExpression(node)){safeExpression(node.whenTrue);safeExpression(node.whenFalse);return;}
    if(ts.isBinaryExpression(node)&&[ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken,ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)){safeExpression(node.right);return;}
    if(ts.isTemplateExpression(node)){
      const signature=node.head.text+node.templateSpans.map(span=>'{}'+span.literal.text).join('');
      if(!templatePatterns.has(signature)){if(/[가-힣]/u.test(signature))unsafe.push({line:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,kind:'template',text:signature});return;}
      let key=node.head.text;node.templateSpans.forEach((span,index)=>{key+=`{p${index+1}}`+span.literal.text;});
      if(node.templateSpans.some(span=>/\b(?:process|Deno|Bun)\s*\.\s*env\b|localStorage|sessionStorage|document\s*\.\s*cookie/u.test(span.expression.getText(sf)))){unsafe.push({line:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,kind:'restricted-interpolation',text:signature});return;}
      const params=node.templateSpans.map((span,index)=>`p${index+1}: ${inline(span.expression)}`).join(', ');messages.add(key);before.add(key);edits.push({start:node.getStart(sf),end:node.end,text:`t(${JSON.stringify(key)}, { ${params} })`});
    }
  };
  const visit=node=>{
    if(ts.isJsxText(node)){
      const value=decodeText(source.slice(node.pos,node.end));if(value&&eligible(value)){const core=value.trim(),left=value.slice(0,value.indexOf(core)),right=value.slice(value.indexOf(core)+core.length);messages.add(core);before.add(core);edits.push({start:node.pos,end:node.end,text:`{${left?JSON.stringify(left)+' + ':''}t(${JSON.stringify(core)})${right?' + '+JSON.stringify(right):''}}`});}return;
    }
    if(ts.isJsxAttribute(node)){
      if(attributes.has(node.name.getText(sf))&&node.initializer){if(ts.isStringLiteral(node.initializer)){const value=decodeText(node.initializer.text)??node.initializer.text;if(eligible(value))record(value,'attribute',node.initializer);}else if(ts.isJsxExpression(node.initializer))safeExpression(node.initializer.expression);}return;
    }
    if(ts.isJsxExpression(node)){safeExpression(node.expression);}
    ts.forEachChild(node,visit);
  };visit(sf);
  const imports=sf.statements.filter(ts.isImportDeclaration), own=imports.find(node=>node.moduleSpecifier.text.endsWith('/i18n')&&!node.importClause?.isTypeOnly);
  const existing=own?.importClause?.namedBindings;
  const hasT=existing&&ts.isNamedImports(existing)&&existing.elements.some(node=>node.name.text==='t');
  const review=node=>{
    if((ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))&&/[가-힣]/u.test(node.text)){
      reviewMessages.add(node.text);const start=node.getStart(sf);let parent=node.parent,localized=false;
      while(parent&&!ts.isSourceFile(parent)){if(ts.isCallExpression(parent)&&ts.isIdentifier(parent.expression)&&parent.expression.text==='t'){localized=true;break;}parent=parent.parent;}
      if(!localized&&!edits.some(edit=>edit.start<=start&&edit.end>=node.end))unsafe.push({line:sf.getLineAndCharacterOfPosition(start).line+1,kind:'manual-static',text:node.text});
    }
    ts.forEachChild(node,review);
  };review(sf);
  let collision=false;
  const bindings=node=>{if(ts.isIdentifier(node)&&node.text==='t'&&[ts.SyntaxKind.VariableDeclaration,ts.SyntaxKind.Parameter,ts.SyntaxKind.FunctionDeclaration,ts.SyntaxKind.ImportSpecifier,ts.SyntaxKind.ImportClause,ts.SyntaxKind.NamespaceImport,ts.SyntaxKind.BindingElement].includes(node.parent.kind)&&node.parent.name===node&&!(own&&node.pos>=own.pos&&node.end<=own.end))collision=true;ts.forEachChild(node,bindings);};bindings(sf);
  if(collision){remaining.push({file:path.relative(root,filename),kind:'binding-conflict',text:'Existing local t binding; no automatic edits applied'});summary.push({file:path.relative(root,filename),edits:0,messages:before.size});continue;}
  if(edits.length&&!hasT){
    if(existing&&ts.isNamedImports(existing))edits.push({start:existing.getStart(sf)+1,end:existing.getStart(sf)+1,text:' t,'});
    else{let relative=path.relative(path.dirname(filename),path.join(sourceRoot,'i18n')).replaceAll('\\','/');if(!relative.startsWith('.'))relative='./'+relative;const at=imports.at(-1)?.end??0;edits.push({start:at,end:at,text:`\nimport { t } from ${JSON.stringify(relative)};\n`});}
  }
  edits.sort((a,b)=>b.start-a.start);for(let index=1;index<edits.length;index++)if(edits[index].end>edits[index-1].start)throw Error(`Overlapping edits in ${filename}`);
  let output=source;for(const edit of edits)output=output.slice(0,edit.start)+edit.text+output.slice(edit.end);
  if(ts.createSourceFile(filename,output,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX).parseDiagnostics.length)throw Error(`Migration produced invalid TSX: ${filename}`);
  if(write&&output!==source)fs.writeFileSync(filename,output);
  summary.push({file:path.relative(root,filename),edits:edits.length,messages:before.size});remaining.push(...unsafe.map(value=>({file:path.relative(root,filename),...value})));
}
if(list||allList)console.log(JSON.stringify([...(allList?new Set([...messages,...reviewMessages]):messages)].sort(),null,2));else console.log(JSON.stringify({write,files:summary,messages:messages.size,manual:remaining},null,2));
