import { createFileRoute, Navigate } from '@tanstack/react-router';

// The gate above shows the sign-in screen until the vault is open; then there is nothing to do here.
export const Route = createFileRoute('/_app/signin')({
  component: () => <Navigate to="/projects" replace />,
});
