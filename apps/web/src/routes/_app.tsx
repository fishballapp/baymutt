import { createFileRoute } from '@tanstack/react-router';
import { OwnerGate, Shell } from '../components/gate.tsx';

// Everything under it needs the open vault.
export const Route = createFileRoute('/_app')({
  component: () => (
    <OwnerGate>
      <Shell />
    </OwnerGate>
  ),
});
