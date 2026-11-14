import { createFileRoute } from '@tanstack/react-router';
import { PasteLinksPage } from '../pages/paste-links.tsx';

export const Route = createFileRoute('/_app/paste-links')({ component: PasteLinksPage });
