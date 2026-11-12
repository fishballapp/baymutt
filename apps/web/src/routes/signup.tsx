import { createFileRoute } from '@tanstack/react-router';
import { Standalone } from '../pages/entry.tsx';
import { SignUpPage } from '../pages/signup.tsx';

export const Route = createFileRoute('/signup')({
  component: () => (
    <Standalone hasBetaNote>
      <SignUpPage />
    </Standalone>
  ),
});
