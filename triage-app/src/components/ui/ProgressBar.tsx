interface ProgressBarProps {
  value: number;
  max: number;
  color?: string;
  height?: string;
  showOverflow?: boolean;
}

export function ProgressBar({
  value,
  max,
  color = "bg-dim",
  height = "h-2",
  showOverflow = false,
}: ProgressBarProps) {
  const percent = Math.min((value / max) * 100, 100);
  const isOver = value > max;
  const barColor = isOver ? "bg-error" : color;

  return (
    <div className={`w-full ${height} bg-card-2 rounded-full overflow-hidden`}>
      <div
        className={`h-full ${barColor} rounded-full transition-all`}
        style={{ width: `${showOverflow ? Math.min((value / max) * 100, 100) : percent}%` }}
      />
    </div>
  );
}
