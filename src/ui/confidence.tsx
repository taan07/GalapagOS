"use client";

// The one gauge (architecture §9): a single bar per worker and per project —
// 0-100 with strong/steady/draining/blocked. Caps and signals live in a
// collapsed debug drilldown, never as default sub-bars; every number
// explains itself and carries its source.
import type { ConfidenceReportView } from "./types";

export function ConfidenceGauge({
  report,
  label,
  computedAt,
  compact = false,
}: {
  report: ConfidenceReportView;
  label: string;
  /** Source attribution — when this picture was computed from evidence. */
  computedAt?: string;
  /** Compact = bar and number only (worker cards); full adds the drilldown. */
  compact?: boolean;
}) {
  const bar = (
    <div
      className={`confidence-gauge state-${report.state}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={report.score}
      aria-label={`${label} confidence: ${report.score}, ${report.state}`}
      title={report.stateReason}
    >
      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: `${report.score}%` }} />
      </div>
      <span className="gauge-score">{report.score}</span>
      <span className="gauge-state">{report.state}</span>
    </div>
  );

  if (compact) {
    return bar;
  }

  const binding = report.caps[0];
  return (
    <div className="confidence-block">
      <div className="confidence-head">
        <span className="confidence-label">{label}</span>
        {bar}
      </div>
      <div className="confidence-reason">{report.stateReason}</div>
      <details className="chip confidence-debug">
        <summary>why {report.score}</summary>
        <div className="confidence-breakdown">
          {computedAt ? (
            <div className="confidence-source">
              computed from evidence at {computedAt.slice(11, 19)} UTC
            </div>
          ) : null}
          <div className="breakdown-section">signals (sum {report.uncappedScore})</div>
          {report.signals.map((signal) => (
            <div key={signal.id} className="breakdown-row">
              <span className={`breakdown-delta ${signal.delta >= 0 ? "positive" : "negative"}`}>
                {signal.delta >= 0 ? `+${signal.delta}` : signal.delta}
              </span>
              <span className="breakdown-label">{signal.label}</span>
            </div>
          ))}
          {report.caps.length > 0 ? (
            <>
              <div className="breakdown-section">caps — positives cannot overcome these</div>
              {report.caps.map((cap) => (
                <div key={cap.id} className={`breakdown-row${cap === binding ? " binding" : ""}`}>
                  <span className="breakdown-delta negative">≤{cap.capTo}</span>
                  <span className="breakdown-label">
                    {cap.label}
                    {cap.blocking ? " [blocks]" : cap.draining ? " [drains]" : ""}
                  </span>
                </div>
              ))}
            </>
          ) : (
            <div className="breakdown-row">
              <span className="breakdown-label">no caps active</span>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
