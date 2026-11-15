// Sotto — inference path badge. The honesty widget: every AI action in the
// UI carries one of these, so the user always sees where their words went.

export function RouterBadge({ path, mode }: { path: string; mode?: 'real' | 'demo' }) {
  const map: Record<string, { label: string; cls: string }> = {
    'on-device': { label: '🔒 on-device', cls: 'badge badge-device' },
    cloud: { label: '☁️ cloud', cls: 'badge badge-cloud' },
    mock: { label: '🧪 demo', cls: 'badge badge-mock' },
    degraded: { label: '✕ unavailable', cls: 'badge badge-degraded' },
  };
  const v = map[path] ?? { label: path, cls: 'badge' };
  return (
    <span className={v.cls}>
      {v.label}
      {mode === 'demo' ? ' (demo)' : ''}
    </span>
  );
}
