import { createFileRoute, redirect } from '@tanstack/react-router';

// Where CLI 0.8.0's `baymutt ask create-environment` links to.
export const Route = createFileRoute('/_app/environment-requests/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/ask/create-environment/$id', params, replace: true });
  },
});
