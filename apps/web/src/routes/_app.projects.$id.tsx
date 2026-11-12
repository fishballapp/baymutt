import { createFileRoute } from '@tanstack/react-router';
import { ProjectPage } from '../pages/project.tsx';

const Page = () => <ProjectPage id={Route.useParams().id} />;

export const Route = createFileRoute('/_app/projects/$id')({ component: Page });
