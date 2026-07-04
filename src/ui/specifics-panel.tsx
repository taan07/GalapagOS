"use client";

import type { SpecificView } from "./types";

export function SpecificsPanel({ specifics }: { specifics: SpecificView[] }) {
  return (
    <aside className="side" aria-label="Agreed specifics">
      <h2>Agreed specifics</h2>
      {specifics.length === 0 ? (
        <p className="empty-note">
          Nothing agreed yet. When you and Darwin pin down a decision, it lands here — and in
          your Obsidian vault.
        </p>
      ) : (
        specifics
          .slice()
          .reverse()
          .map((specific) => (
            <div className="specific" key={specific.fileName}>
              <div className="q">{specific.question}</div>
              <div className="a">{specific.answer}</div>
              <div className="meta">
                {specific.status} · {specific.createdAt.slice(0, 10)}
              </div>
            </div>
          ))
      )}
    </aside>
  );
}
