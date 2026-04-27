import { ReactNode } from 'react';

export type Column<T> = {
  key: string;
  label: string;
  span: number; // 12-grid column span; columns should sum to 12
  align?: 'left' | 'right' | 'center';
  render: (row: T) => ReactNode;
};

type Props<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowClassName?: (row: T) => string;
  empty?: ReactNode;
  className?: string;
};

const alignClass = {
  left: 'text-left justify-start',
  right: 'text-right justify-end',
  center: 'text-center justify-center',
} as const;

// 12-column responsive grid table. Headers and rows share the same grid so
// columns line up perfectly. Column spans are passed via inline style instead
// of `col-span-N` classes so Tailwind's JIT doesn't purge dynamic values.
export function Table<T>({
  columns,
  rows,
  rowKey,
  rowClassName,
  empty,
  className = '',
}: Props<T>) {
  return (
    <div className={`w-full ${className}`}>
      {/* header */}
      <div className="grid grid-cols-12 px-3 py-1.5 gap-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-300 border-b border-neutral-700">
        {columns.map((col) => (
          <div
            key={col.key}
            className={`flex items-center ${alignClass[col.align ?? 'left']}`}
            style={{ gridColumn: `span ${col.span} / span ${col.span}` }}
          >
            {col.label}
          </div>
        ))}
      </div>

      {/* body */}
      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-neutral-500">
          {empty ?? 'No data'}
        </div>
      ) : (
        rows.map((row) => (
          <div
            key={rowKey(row)}
            className={[
              'grid grid-cols-12 px-3 py-1.5 items-center gap-3',
              'border-b border-neutral-800 hover:bg-neutral-800 transition-colors duration-100',
              rowClassName?.(row) ?? '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {columns.map((col) => (
              <div
                key={col.key}
                className={`flex items-center min-w-0 ${alignClass[col.align ?? 'left']}`}
                style={{ gridColumn: `span ${col.span} / span ${col.span}` }}
              >
                {col.render(row)}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
