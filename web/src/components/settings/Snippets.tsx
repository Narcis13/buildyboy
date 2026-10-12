import { CopyButton } from '../ui.tsx';
import { SectionCard } from './bits.tsx';

function Snippet({ title, text, testId }: { title: string; text: string; testId: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[15px] font-medium">{title}</span>
        <CopyButton text={text} />
      </div>
      <pre data-testid={testId} className="whitespace-pre-wrap break-all rounded-lg border border-line bg-bg-2 p-3 font-mono text-sm leading-snug">{text}</pre>
    </div>
  );
}

export function otelSnippet(publicUrl: string): string {
  return JSON.stringify(
    {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: publicUrl,
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer <machine token>',
      },
    },
    null,
    2,
  );
}

export const STATUSLINE_SNIPPET = JSON.stringify({ statusLine: { type: 'command', command: 'node ~/.buildyboy/plugin/statusline/bb-statusline.mjs' } }, null, 2);

/** The two optional pieces that are pasted into ~/.claude/settings.json by hand. Buildyboy never edits that file. */
export function SnippetsSection({ publicUrl }: { publicUrl: string }) {
  return (
    <SectionCard
      title="Telemetry and statusline"
      hint="Optional. Both go into ~/.claude/settings.json on each machine. Buildyboy never edits that file for you."
      testId="settings-snippets"
    >
      <Snippet title="OpenTelemetry (exact cost, tokens and latency)" text={otelSnippet(publicUrl)} testId="snippet-otel" />
      <p className="text-sm text-muted">
        Replace <code className="font-mono text-ink">&lt;machine token&gt;</code> with that machine's token: it is in <code className="font-mono">~/.buildyboy/config.json</code>, or use Rotate token on the Machines page to get a fresh one.
        Merge the <code className="font-mono">env</code> block into the existing one if there is one.
      </p>
      <Snippet title="Statusline bridge (context % and rate limits)" text={STATUSLINE_SNIPPET} testId="snippet-statusline" />
      <p className="text-sm text-muted">
        The bridge posts the statusline JSON (throttled to once every 10 s per session) and then runs your previous statusline command, passing its output through.
        If you already have a <code className="font-mono">statusLine</code>, move its command into the <code className="font-mono text-ink">BUILDYBOY_STATUSLINE_NEXT</code> environment variable (in the same <code className="font-mono">env</code> block) so the bridge can wrap it, for example
        <code className="mt-1 block break-all font-mono text-ink">{'"BUILDYBOY_STATUSLINE_NEXT": "your old statusline command"'}</code>
      </p>
    </SectionCard>
  );
}
