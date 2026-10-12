import { PageTitle } from '../components/ui.tsx';

export default function Jobs({ id }: { id?: string }) {
  return <PageTitle>Jobs {String(id ?? '')}</PageTitle>;
}
