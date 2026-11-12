import { ProjectNameSchema } from '@baymutt/api';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { CaretRightIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import * as Schema from 'effect/Schema';
import { useState } from 'react';
import { useOwner } from '../components/gate.tsx';
import {
  Code,
  CommandLine,
  Empty,
  Notice,
  PageHeader,
  Row,
  Rows,
  Skeleton,
  Time,
} from '../components/parts.tsx';
import { Button } from '../components/ui/button.tsx';
import { TextField } from '../components/ui/field.tsx';
import { createProjectAtom, projectsAtom } from '../lib/data.ts';
import { counted } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

const isProjectName = Schema.is(ProjectNameSchema);

const NewProject = () => {
  const owner = useOwner();
  const [creation, create] = useAtom(createProjectAtom, { mode: 'promiseExit' });
  const [name, setName] = useState('');
  const isValid = isProjectName(name);
  return (
    <form
      className="mb-8"
      onSubmit={async event => {
        event.preventDefault();
        const exit = await create({ owner, name });
        if (exit._tag === 'Success') setName('');
      }}
    >
      <TextField
        label="New project"
        isCode
        placeholder="app/production"
        hint="Lower-case segments joined by /. Dev and production are separate projects, so a machine granted one cannot reach the other."
        error={
          name !== '' && !isValid
            ? 'Use lower-case letters, digits, dots and dashes, in segments joined by /.'
            : failureMessage(creation)
        }
        value={name}
        onChange={event => setName(event.target.value)}
        action={
          <Button type="submit" intent="primary" disabled={!isValid || creation.waiting}>
            {creation.waiting ? 'Creating…' : 'Create project'}
          </Button>
        }
      />
    </form>
  );
};

export const ProjectsPage = () => {
  const result = useAtomValue(projectsAtom);
  const projects = latest(result);
  return (
    <>
      <PageHeader
        title="Projects"
        lede="A project is the unit of access: a machine is granted read, write or both on one."
      />
      <NewProject />
      {failureMessage(result) && <Notice>{failureMessage(result)}</Notice>}
      {projects === null && !failureMessage(result) && <Skeleton />}
      {projects?.length === 0 && (
        <Empty title="No projects yet">
          <p>
            Create one above, or let an agent create it from a paired machine. A project an agent
            creates shows up here, and you can read it.
          </p>
          <CommandLine>baymutt projects create app/production</CommandLine>
        </Empty>
      )}
      {projects !== null && projects.length > 0 && (
        <Rows>
          {projects.map(project => (
            <Row key={project.id} className="p-0">
              <Link
                to="/projects/$id"
                params={{ id: project.id }}
                className="group flex items-center gap-4 px-4 py-3 transition-colors duration-150 ease-out hover:bg-sunken focus-visible:-outline-offset-2"
              >
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5">
                  <Code className="text-base font-medium">{project.name}</Code>
                  <span className="text-sm text-muted">
                    {counted(project.secretCount, 'secret')} · made by {project.createdBy.name}{' '}
                    <Time at={project.createdAt} />
                  </span>
                </span>
                <CaretRightIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted transition-colors duration-150 ease-out group-hover:text-foreground"
                />
              </Link>
            </Row>
          ))}
        </Rows>
      )}
    </>
  );
};
