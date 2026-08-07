const colorMap: Record<string, string> = {
  blue: "bg-jake",
  purple: "bg-emma",
  green: "bg-sophie",
};

interface KidBadgeProps {
  name: string;
  color: string;
  size?: "sm" | "md";
}

export function KidBadge({ name, color, size = "sm" }: KidBadgeProps) {
  const dotSize = size === "sm" ? "w-2.5 h-2.5" : "w-3 h-3";
  return (
    <div className="flex items-center gap-2">
      <div className={`${dotSize} rounded-full ${colorMap[color] || "bg-dim"}`} />
      <span className={size === "sm" ? "text-sm" : "text-base"}>{name}</span>
    </div>
  );
}
