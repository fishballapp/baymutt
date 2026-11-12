import { createFileRoute } from '@tanstack/react-router';
import { Standalone } from '../pages/entry.tsx';
import { PastePage } from '../pages/paste.tsx';

const Page = () => (
  <Standalone>
    <PastePage id={Route.useParams().id} />
  </Standalone>
);

export const Route = createFileRoute('/paste/$id')({ component: Page });
