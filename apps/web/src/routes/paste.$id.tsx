import { createFileRoute } from '@tanstack/react-router';
import { OwnerGate } from '../components/gate.tsx';
import { Standalone } from '../pages/entry.tsx';
import { PastePage } from '../pages/paste.tsx';

// The signed-in owner's alone: signed out, the link shows sign-in in place and keeps its address.
const Page = () => (
  <OwnerGate>
    <Standalone>
      <PastePage id={Route.useParams().id} />
    </Standalone>
  </OwnerGate>
);

export const Route = createFileRoute('/paste/$id')({ component: Page });
