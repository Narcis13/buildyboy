import { useEffect } from 'react';
import { Button, PageTitle } from '../components/ui.tsx';
import { navigate, useLocation, useQueryParam } from '../lib/router.tsx';
import { JobList } from '../components/jobs/JobList.tsx';
import { JobDetail } from '../components/jobs/JobDetail.tsx';
import { LaunchForm } from '../components/jobs/LaunchForm.tsx';
import { Schedules } from '../components/jobs/Schedules.tsx';

/** The root font size is 15px, so Tailwind's min-h-11 is 41.25px; keep every control on these pages at 44px or more. */
const TOUCH = '[&_a]:!min-h-[44px] [&_button]:!min-h-[44px] [&_input]:!min-h-[44px] [&_select]:!min-h-[44px] [&_summary]:!min-h-[44px]';

/** /jobs (list + schedules), /jobs/:id (detail), /jobs?new=1&prompt=<id> (launch form; the Composer links here). */
export default function Jobs({ id }: { id?: string }) {
  const isNew = useQueryParam('new') === '1';
  const prompt = useQueryParam('prompt');
  const schedule = useQueryParam('schedule') === '1';
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === '#schedules') document.getElementById('schedules')?.scrollIntoView();
  }, [hash]);

  if (id) return <div className={TOUCH}><JobDetail key={id} id={id} /></div>;
  if (isNew) return <div className={TOUCH}><LaunchForm key={`${prompt}-${schedule}`} promptId={prompt} schedule={schedule} /></div>;
  return (
    <div className={`mx-auto max-w-5xl ${TOUCH}`}>
      <PageTitle right={<Button variant="primary" onClick={() => navigate('/jobs?new=1')}>New job</Button>}>Jobs</PageTitle>
      <JobList />
      <Schedules />
    </div>
  );
}
