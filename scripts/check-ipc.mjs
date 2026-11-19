import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = fs.readFileSync('src/ipc/commands.ts', 'utf8');
const tree = ts.createSourceFile('commands.ts', source, ts.ScriptTarget.Latest, true);
const contract = tree.statements.find(n => ts.isInterfaceDeclaration(n) && n.name.text === 'Commands');
assert(contract, 'Missing command contracts');
const names = contract.members.map(n => n.name.text);
assert.equal(new Set(names).size, names.length, 'Duplicate command contracts');
const native = fs.readFileSync('src-tauri/src/main.rs', 'utf8');
const registered = native.match(/generate_handler!\[([\s\S]*?)\]/)?.[1].split(',').map(n => n.trim()).filter(Boolean);
assert(registered?.length, 'Missing Tauri command registration');
for (const name of names) assert(registered.includes(name), `IPC command is not registered: ${name}`);
console.log(JSON.stringify({ commandContracts: names.length, nativeCommands: registered.length, unknownCommands: 0 }));
