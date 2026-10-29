import { useState, type ReactNode } from 'react';
import { getLocale, t } from './i18n';

type Value = string | number | null | undefined;
type Column<T> = { value: (row: T) => Value; enum?: boolean; label?: (value: string) => string } | null;
export interface TableControls {
  revision: string;
  direction: (index: number) => 'ascending' | 'descending' | 'none';
  heading: (index: number, label: ReactNode) => ReactNode;
  filter: (index: number, label: string) => ReactNode;
  clearFilters: () => void;
}

export function useTableRows<T>(input: readonly T[], columns: readonly Column<T>[]) {
  const [sort, setSort] = useState<{ index: number; descending: boolean } | null>(null);
  const [filters, setFilters] = useState<Record<number, string>>({});
  const collator = new Intl.Collator(getLocale(), { numeric: true, sensitivity: 'base' });
  const compare = (a: Value, b: Value) => typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
  const rows = input.filter(row => columns.every((column, index) => !filters[index] || String(column?.value(row) ?? '') === filters[index]));
  if (sort && columns[sort.index]) {
    const value = columns[sort.index]!.value;
    rows.sort((a, b) => {
      const left = value(a), right = value(b);
      const missingLeft = left == null || typeof left === 'number' && !Number.isFinite(left);
      const missingRight = right == null || typeof right === 'number' && !Number.isFinite(right);
      if (missingLeft || missingRight) return Number(missingLeft) - Number(missingRight);
      return compare(left, right) * (sort.descending ? -1 : 1);
    });
  }
  const direction = (index: number) => sort?.index === index ? sort.descending ? 'descending' as const : 'ascending' as const : 'none' as const;
  const controls: TableControls = {
    revision: JSON.stringify([sort, filters]), direction, clearFilters: () => setFilters({}),
    heading: (index, label) => {
      const column = columns[index];
      if (!column) return label;
      const state = direction(index);
      return <button type="button" className="table-sort" onClick={() => setSort(previous => previous?.index === index ? previous.descending ? null : { index, descending: true } : { index, descending: false })}>{label}<span aria-hidden="true">{state === 'ascending' ? '↑' : state === 'descending' ? '↓' : '↕'}</span><span className="sr-only">{t('정렬')}</span></button>;
    },
    filter: (index, label) => {
      const column = columns[index];
      if (!column?.enum) return null;
      const choices = [...new Set(input.map(row => String(column.value(row) ?? '')))].filter(Boolean).sort(collator.compare);
      if (filters[index] && !choices.includes(filters[index])) choices.push(filters[index]);
      return <label className="table-filter-field" key={index}><span>{label}</span><select className="table-filter" aria-label={t('{column} 필터', { column: label })} value={filters[index] ?? ''} onChange={event => setFilters(previous => ({ ...previous, [index]: event.target.value }))}><option value="">{t('전체')}</option>{choices.map(value => <option key={value} value={value}>{column.label?.(value) ?? t(value)}</option>)}</select></label>;
    },
  };
  return { rows, ...controls };
}

export function TableFilters({ controls, labels }: { controls: TableControls; labels: Record<number, string> }) {
  return <div className="table-filters" aria-label={t('표 필터')}>{Object.entries(labels).map(([index, label]) => controls.filter(Number(index), label))}</div>;
}
