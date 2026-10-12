import { PageTitle } from '../components/ui.tsx';

export default function Projects({ id }: { id?: string }) {
  return <PageTitle>Projects {String(id ?? '')}</PageTitle>;
}
