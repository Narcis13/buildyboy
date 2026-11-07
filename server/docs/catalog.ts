// The manual's table of contents: one entry per page in templates/pages/<slug>.faqir, in reading order.

export interface DocPage {
  slug: string;
  title: string;
  /** one sentence: the page's subtitle, its card on the manual's home and its <meta name="description"> */
  summary: string;
}

export interface DocSection {
  title: string;
  pages: DocPage[];
}

export const SECTIONS: DocSection[] = [
  {
    title: 'Getting started',
    pages: [
      { slug: 'index', title: 'Welcome', summary: 'What Buildyboy is, what it is for, and how to find your way around this manual.' },
      { slug: 'quick-start', title: 'Quick start', summary: 'From a fresh server to your first session on the Floor, step by step, in about fifteen minutes.' },
      { slug: 'concepts', title: 'How it works', summary: 'Machines, sessions, hooks, the server, the runner and walk mode: the few ideas everything else is built on.' },
    ],
  },
  {
    title: 'Everyday use',
    pages: [
      { slug: 'floor', title: 'The Floor', summary: 'The live overview of every session on every machine, and how to read a station at a glance.' },
      { slug: 'sessions', title: 'Following a session', summary: 'The timeline, the side panels, and how to steer, pause or stop a session from its page.' },
      { slug: 'inbox', title: 'The Inbox', summary: 'Approving tool calls, answering questions, approving plans and replying when a turn ends.' },
      { slug: 'walk-mode', title: 'Walk mode', summary: 'Hand your sessions over to your phone, and what happens when you are slow to answer.' },
      { slug: 'notifications', title: 'Notifications', summary: 'Web Push on phones and desktops, the ntfy fallback, and muting a noisy session.' },
    ],
  },
  {
    title: 'The factory',
    pages: [
      { slug: 'composer', title: 'The Composer', summary: 'Writing a harness prompt that Claude can run unattended: the slots, the lint, the library and Spec-ify.' },
      { slug: 'jobs', title: 'Jobs and schedules', summary: 'Launching a prompt as a job on one of your machines, watching it, verifying it and running it on a schedule.' },
      { slug: 'runner', title: 'Setting up the runner', summary: 'The small daemon that lets the server start Claude Code on a machine, and the folders it is allowed to touch.' },
      { slug: 'backlog', title: 'Backlog, gates and decisions', summary: 'The packages the factory works on, their gates and screenshots, stopping or reverting one, and answering the coordinator.' },
      { slug: 'coordinator', title: 'Running a coordinator', summary: 'Connecting a Claude Code coordinator through the MCP server, the consumption governor, herdr terminals, and turning it all on.' },
    ],
  },
  {
    title: 'Your setup',
    pages: [
      { slug: 'machines', title: 'Pairing machines', summary: 'Connecting Windows, WSL, macOS and Linux machines, checking them, and removing them again.' },
      { slug: 'settings', title: 'Settings', summary: 'Every section of the Settings page: account, notifications, redaction, telemetry snippets and more.' },
      { slug: 'projects', title: 'Projects', summary: 'How sessions are grouped by repository, and what a project page shows.' },
      { slug: 'insights', title: 'Insights, search and import', summary: 'Cost and token charts, full-text search across every session, and backfilling old history.' },
    ],
  },
  {
    title: 'Reference',
    pages: [
      { slug: 'commands', title: 'Commands', summary: 'Every slash command, every bb subcommand and every installer option, with examples.' },
      { slug: 'server', title: 'Running the server', summary: 'Deploying, updating, backing up and restoring the server, and the settings it reads from its environment.' },
      { slug: 'security', title: 'Security and privacy', summary: 'What is stored, what is masked, who can do what, and how to lock things down.' },
      { slug: 'troubleshooting', title: 'Troubleshooting and FAQ', summary: 'Symptoms, causes and fixes for the problems people actually run into.' },
      { slug: 'glossary', title: 'Glossary', summary: 'Every Buildyboy and Claude Code term used in this manual, in one place.' },
    ],
  },
];

export const PAGES: DocPage[] = SECTIONS.flatMap((s) => s.pages);

export function docHref(slug: string): string {
  return slug === 'index' ? '/docs' : `/docs/${slug}`;
}
