import { createFileRoute } from '@tanstack/react-router';
import { PasteLinksPage } from '../pages/paste-links.tsx';

export const Route = createFileRoute('/_app/orgs/$slug/paste-links')({ component: PasteLinksPage });
