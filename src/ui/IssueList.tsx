import { useState } from 'react';
import type { IssueSpot } from '../geometry/output';

interface Props {
  issues: IssueSpot[];
  onFocus: (i: IssueSpot) => void;
  /** List every entry on its own (no grouping), e.g. for per-net information. */
  plain?: boolean;
}

/** Issues grouped by message; clicking a group steps through its locations in the preview. */
export function IssueList({ issues, onFocus, plain }: Props) {
  const [cursor, setCursor] = useState<Record<string, number>>({});
  const groups = new Map<string, IssueSpot[]>();
  issues.forEach((i, k) => {
    const key = plain ? String(k) : i.message;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  if (!groups.size) return null;
  const fmt = (i: IssueSpot) => `(${(i.at[0] + 0).toFixed(1)}, ${(i.at[1] + 0).toFixed(1)})`;
  return (
    <ul className="issues">
      {[...groups].map(([message, spots]) => {
        const label = spots[0].message;
        const next = cursor[message] ?? 0;
        return (
          <li key={message}>
            <button
              className="link"
              title={spots.length > 1 ? 'Click repeatedly to visit every location' : 'Show in the preview'}
              onClick={() => {
                onFocus(spots[next % spots.length]);
                setCursor((c) => ({ ...c, [message]: (next + 1) % spots.length }));
              }}
            >
              {spots.length > 1 ? `${spots.length} × ${label}` : `${label} at ${fmt(spots[0])}`}
            </button>
            {spots.length > 1 && cursor[message] !== undefined && (
              <span className="issue-pos">
                {' '}
                showing {((next - 1 + spots.length) % spots.length) + 1}/{spots.length} {fmt(spots[(next - 1 + spots.length) % spots.length])}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
