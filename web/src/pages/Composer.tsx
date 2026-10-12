import { PageTitle } from '../components/ui.tsx';

export default function Composer({ promptId }: { promptId?: string }) {
  return <PageTitle>Composer {String(promptId ?? '')}</PageTitle>;
}
