const colorMap: Record<string, string> = {
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  green: "bg-green-500",
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
      <div className={`${dotSize} rounded-full ${colorMap[color] || "bg-zinc-500"}`} />
      <span className={size === "sm" ? "text-sm" : "text-base"}>{name}</span>
    </div>
  );
}
