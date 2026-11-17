import { createFileRoute, redirect } from '@tanstack/react-router';

// The page was called Service accounts before it was Keys.
export const Route = createFileRoute('/_app/service-accounts')({
  beforeLoad: () => {
    throw redirect({ to: '/keys', replace: true });
  },
});
