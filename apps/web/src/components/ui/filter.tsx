import { type ReactNode, useId, useState } from 'react';
import { Button } from './button.tsx';
import { FILTER_THRESHOLD } from './list.tsx';

/**
 * A page's filter query. The filter shows while the page holds more than the threshold of rows to
 * filter, and stays while its query is not empty; `matches` narrows case-insensitively.
 */
export const useFilter = (rowCount: number) => {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  return {
    query,
    setQuery,
    clear: () => setQuery(''),
    isFiltering: needle !== '',
    isShown: rowCount > FILTER_THRESHOLD || query !== '',
    /** Whether any of a row's matched fields holds the query. */
    matches: (...fields: ReadonlyArray<string>) =>
      needle === '' || fields.some(field => field.toLowerCase().includes(needle)),
  };
};

/** `.filter`: the visible word "Filter", then the input. */
export const Filter = ({
  filter,
  placeholder,
}: {
  readonly filter: ReturnType<typeof useFilter>;
  /** What it matches on: "name or environment". */
  readonly placeholder: string;
}) => {
  const id = useId();
  return (
    <div className="filter">
      <label htmlFor={id}>Filter</label>
      <input
        id={id}
        type="search"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={filter.query}
        onChange={event => filter.setQuery(event.target.value)}
      />
    </div>
  );
};

/** `.no-match`, in the lists' place: its sentence, then a quiet "Clear filter". */
export const NoMatch = ({
  filter,
  children,
}: {
  readonly filter: ReturnType<typeof useFilter>;
  /** "No key in Acme matches “stag”." */
  readonly children: ReactNode;
}) => (
  <p className="no-match">
    {children}
    <Button kind="quiet" onClick={filter.clear}>
      Clear filter
    </Button>
  </p>
);
