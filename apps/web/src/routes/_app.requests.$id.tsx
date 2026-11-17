import { createFileRoute, redirect } from '@tanstack/react-router';

// Where CLI 0.8.0's `baymutt ask access` links to.
export const Route = createFileRoute('/_app/requests/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/ask/access/$id', params, replace: true });
  },
});
