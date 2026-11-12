// When a service account stops working: chosen on the approval page and changed from the list.
// Expiring, like revoking, does not take back what it already read.
import { useState } from 'react';
import { exactDay, exactTime } from '../lib/format.ts';
import { SelectField, TextField } from './ui/field.tsx';

const DAY_MS = 24 * 3600 * 1000;

const PRESETS = [
  { choice: '30', label: 'In 30 days', days: 30 },
  { choice: '90', label: 'In 90 days', days: 90 },
  { choice: '365', label: 'In a year', days: 365 },
] as const;

type Choice = 'kept' | 'never' | 'date' | (typeof PRESETS)[number]['choice'];

/** The first moment of a local calendar day picked in a date input: `2026-12-01`, or '' before one is. */
const startOfDay = (day: string): number | null =>
  day === ''
    ? null
    : Temporal.PlainDate.from(day).toZonedDateTime(Temporal.Now.timeZoneId()).epochMilliseconds;

/** Tomorrow in this browser's calendar, the first day a date input offers. */
const tomorrow = () => Temporal.Now.plainDateISO().add({ days: 1 }).toString();

/**
 * A choice of when it expires. `kept` is a time already set or asked for, offered first and
 * labelled `keptLabel`. Reports each change as a time, null for never, or undefined while a
 * date is still missing.
 */
export const ExpiryField = ({
  kept,
  keptLabel,
  onChange,
}: {
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
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="w-full sm:w-72">
        <SelectField
          label="Expires"
          value={choice}
          onChange={event => {
            const next = event.target.value as Choice;
            setChoice(next);
            report(next, day);
          }}
        >
          {kept !== null && <option value="kept">{keptLabel(kept)}</option>}
          <option value="never">Never</option>
          {PRESETS.map(({ choice, label }) => (
            <option key={choice} value={choice}>
              {label}
            </option>
          ))}
          <option value="date">On a date…</option>
        </SelectField>
      </div>
      {choice === 'date' && (
        <div className="w-full sm:w-48">
          <TextField
            label="Date"
            type="date"
            value={day}
            min={tomorrow()}
            max="9999-12-31"
            onChange={event => {
              setDay(event.target.value);
              report('date', event.target.value);
            }}
          />
        </div>
      )}
    </div>
  );
};

/** "Dec 1, 2026" for a whole day, the exact time for anything shorter than one. */
export const expiryLabel = (at: number): string =>
  at - Date.now() < DAY_MS ? exactTime(at) : exactDay(at);
