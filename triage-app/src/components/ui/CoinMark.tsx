interface CoinMarkProps {
  size?: number;
  className?: string;
}

/**
 * TYRION coin mark — the canonical "simplified" cut: gold radial face,
 * dark rim, inner ring, and a serif "T". Detail scales with size.
 */
export function CoinMark({ size = 30, className = "" }: CoinMarkProps) {
  const showInnerRing = size >= 22;
  const gid = `tycoin-${size}`;
  return (
    <svg
      className={`coin ${className}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="TYRION"
    >
      <defs>
        <radialGradient id={gid} cx="38%" cy="34%" r="72%">
          <stop offset="0%" stopColor="#F0D585" />
          <stop offset="52%" stopColor="#C9A24A" />
          <stop offset="100%" stopColor="#8A6B27" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="47" fill={`url(#${gid})`} />
      <circle cx="50" cy="50" r="47" fill="none" stroke="#6b5220" strokeWidth="2.4" />
      {showInnerRing && (
        <circle cx="50" cy="50" r="38" fill="none" stroke="#7a5e28" strokeWidth="1.6" opacity="0.7" />
      )}
      <text
        x="50"
        y="50"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily='"Cormorant Garamond", Georgia, serif'
        fontWeight="700"
        fontSize={size >= 22 ? 54 : 66}
        fill="#3a2c0c"
      >
        T
      </text>
    </svg>
  );
}
