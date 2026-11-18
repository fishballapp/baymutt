// When a key or a CLI login stops working: chosen on the pairing page and changed from a list.
// Expiring, like revoking, does not take back what it already read.
import { useState } from 'react';
import { DAY_MS, exactDay, exactTime } from '../lib/format.ts';
import { TextField } from './ui/field.tsx';
import { Select, type SelectOption } from './ui/select.tsx';

const PRESETS = [
  { choice: '30', label: 'In 30 days', days: 30 },
  { choice: '90', label: 'In 90 days', days: 90 },
  { choice: '365', label: 'In a year', days: 365 },
] as const;

type Choice = 'kept' | 'never' | 'date' | (typeof PRESETS)[number]['choice'];

/**
 * The first moment of a local calendar day picked in a date input (`2026-12-01`), or null while
 * none is chosen. A day before tomorrow is not a choice: typed by hand it passes the input's `min`,
 * and would make a key that has already ended (`0002-12-01` included).
 */
const startOfDay = (day: string): number | null =>
  day === '' || day < tomorrow()
    ? null
    : Temporal.PlainDate.from(day).toZonedDateTime(Temporal.Now.timeZoneId()).epochMilliseconds;

/** Tomorrow in this browser's calendar, the first day a date input offers. */
const tomorrow = () => Temporal.Now.plainDateISO().add({ days: 1 }).toString();

/**
 * A choice of when a key or CLI login ends. `kept` is a time already set or asked for, offered
 * first and labelled `keptLabel`. Reports each change as a time, null for never, or undefined
 * while "On a date…" has no date yet (the save stays disabled then).
 * - `dialog`: the Expiry dialogs, an "Expires" field, then a "Date" field as the next part of the
 *   dialog body;
 * - `decision`: the pairing page, "Ends" beside its select, then `.ends-date`.
 */
export const ExpiryField = ({
  placement = 'dialog',
  kept,
  keptLabel,
  onChange,
}: {
  readonly placement?: 'dialog' | 'decision';
  readonly kept: number | null;
  readonly keptLabel: (at: number) => string;
  readonly onChange: (expiresAt: number | null | undefined) => void;
}) => {
  const [choice, setChoice] = useState<Choice>(kept === null ? 'never' : 'kept');
  const [day, setDay] = useState('');
  const report = (next: Choice, nextDay: string) => {
    if (next === 'kept') return onChange(kept);
    if (next === 'never') return onChange(null);
    if (next === 'date') return onChange(startOfDay(nextDay) ?? undefined);
    const preset = PRESETS.find(({ choice }) => choice === next);
    onChange(preset === undefined ? undefined : Date.now() + preset.days * DAY_MS);
  };
  const options: ReadonlyArray<SelectOption<Choice>> = [
    ...(kept === null ? [] : [{ value: 'kept' as const, label: keptLabel(kept) }]),
    { value: 'never', label: 'Never' },
    ...PRESETS.map(({ choice, label }) => ({ value: choice, label })),
    { value: 'date', label: 'On a date…' },
  ];
  const date = choice === 'date' && (
    <TextField
      label="Date"
      type="date"
      className={placement === 'decision' ? 'ends-date' : undefined}
      value={day}
      min={tomorrow()}
      max="9999-12-31"
      onValueChange={nextDay => {
        setDay(nextDay);
        report('date', nextDay);
      }}
    />
  );
  return (
    <>
      <Select
        label={placement === 'decision' ? 'Ends' : 'Expires'}
        labelPlacement={placement === 'decision' ? 'beside' : 'above'}
        options={options}
        value={choice}
        onValueChange={next => {
          setChoice(next);
          report(next, day);
        }}
      />
      {date}
    </>
  );
};

/** "Dec 1, 2026" for a whole day, the exact time for anything shorter than one. */
export const expiryLabel = (at: number): string =>
  at - Date.now() < DAY_MS ? exactTime(at) : exactDay(at);
