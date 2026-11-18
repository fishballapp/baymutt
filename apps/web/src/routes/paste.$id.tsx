import { createFileRoute } from '@tanstack/react-router';
import { OwnerGate } from '../components/gate.tsx';
import { PastePage } from '../pages/paste.tsx';

// The signed-in owner's alone: signed out, the link shows sign-in in place and keeps its address.
// Keyed by the link: another link's page starts with nothing typed and nothing sent.
const Page = () => {
  const { id } = Route.useParams();
  return (
    <OwnerGate>
      <PastePage key={id} id={id} />
    </OwnerGate>
  );
};

export const Route = createFileRoute('/paste/$id')({ component: Page });
