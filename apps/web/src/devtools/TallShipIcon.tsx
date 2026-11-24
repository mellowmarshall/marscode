import type { IconSvgProps } from "./devdeckTypes";

/**
 * 3-masted tall sailing ship line icon matching Lucide stroke geometry (24x24, 1.75 stroke).
 */
export function TallShipIcon(props: IconSvgProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* Center mast & top flag */}
      <path d="M12 2.5v13.5" />
      <path d="M12 2.5h2.7v2H12" />
      {/* Center sails */}
      <path d="M9.6 6h4.2c.6 1 .6 2.1 0 3.1H9.6c.5-1 .5-2.1 0-3.1Z" />
      <path d="M8.8 10.6h5.4c.7 1.3.7 2.8 0 4.1H8.8c.6-1.3.6-2.8 0-4.1Z" />
      {/* Left mast & sails */}
      <path d="M6.8 5v11" />
      <path d="M5 6.8h3c.4.8.4 1.7 0 2.5H5c.4-.8.4-1.7 0-2.5Z" />
      <path d="M4.4 10.9h3.4c.4 1 .4 2.2 0 3.2H4.4c.4-1 .4-2.2 0-3.2Z" />
      {/* Right mast & sails */}
      <path d="M16.8 6.5v9.5" />
      <path d="M15.4 8h2.6c.4.7.4 1.5 0 2.2h-2.6c.3-.7.3-1.5 0-2.2Z" />
      <path d="M15.6 11.6h2.8c.4.9.4 2 0 2.9h-2.8c.4-.9.4-2 0-2.9Z" />
      {/* Bowsprit & hull */}
      <path d="M18.6 16l3.4-1.9" />
      <path d="M3.5 16h4.1l1.1 1.3h5.1l1.1-1.3h3.9l-1.5 4.2a1.5 1.5 0 0 1-1.4 1H7a1.5 1.5 0 0 1-1.4-1L3.5 16Z" />
      {/* Portholes */}
      <circle cx="8.2" cy="18.9" r="0.65" />
      <circle cx="11.5" cy="18.9" r="0.65" />
      <circle cx="14.8" cy="18.9" r="0.65" />
    </svg>
  );
}
