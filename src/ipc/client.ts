import { invoke } from '@tauri-apps/api/core';
import type { CommandName, CommandArgs, CommandResult, NoArgCommand, ArgCommand } from './commands';

export function backend<C extends NoArgCommand>(command: C, args?: undefined): Promise<CommandResult<C>>;
export function backend<C extends ArgCommand>(command: C, args: CommandArgs<C>): Promise<CommandResult<C>>;
export async function backend(command: CommandName, args?: CommandArgs<CommandName>): Promise<unknown> {
  if (command === 'image_search') {
    const term = args && 'term' in args && typeof args.term === 'string' ? args.term.trim() : '';
    const parts = term.split('/');
    if (!term || term.length > 128 || !/^[A-Za-z0-9/_.-]+$/.test(term) || term.includes('..')
      || parts.some(part => !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(part))
      || (parts.length > 1 && parts[0].includes('.'))) {
      throw new Error('Docker Hub 검색어는 1~128자의 영문, 숫자, /, _, ., -로 입력하세요. 외부 레지스트리 주소는 검색할 수 없습니다.');
    }
    args = { ...args, term };
  }
  if (!('__TAURI_INTERNALS__' in window)) throw new Error('데스크톱 백엔드에 연결할 수 없습니다. DockSlate Windows 앱에서 실행하세요.');
  return invoke(command, args);
}
