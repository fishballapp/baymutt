import { createFileRoute } from '@tanstack/react-router';
import { Standalone } from '../pages/entry.tsx';
import { RecoverPage } from '../pages/recover.tsx';

export const Route = createFileRoute('/recover')({
  component: () => (
    <Standalone hasBetaNote>
      <RecoverPage />
    </Standalone>
  ),
});
