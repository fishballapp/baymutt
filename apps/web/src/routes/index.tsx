import { createFileRoute, Navigate } from '@tanstack/react-router';

// In production `/` is the landing page, a static file this app never renders. This route is
// what the dev server shows there.
export const Route = createFileRoute('/')({
  component: () => <Navigate to="/signin" replace />,
});
