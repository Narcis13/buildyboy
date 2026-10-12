import { PageTitle } from '../components/ui.tsx';

export default function Session({ id }: { id: string }) {
  return <PageTitle>Session {String(id ?? '')}</PageTitle>;
}
