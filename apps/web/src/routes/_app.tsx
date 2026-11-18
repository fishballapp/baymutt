import { createFileRoute } from '@tanstack/react-router';
import { OwnerGate } from '../components/gate.tsx';
import { AppShell } from '../components/shell.tsx';

// Everything under it needs the open vault.
export const Route = createFileRoute('/_app')({
  component: () => (
    <OwnerGate>
      <AppShell />
    </OwnerGate>
  ),
});
