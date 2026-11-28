import type { IconSvgProps } from "./devdeckTypes";

/** Fleet Console mark: one mast, two sails, and a hull, on Lucide's 24px grid and stroke. */
export function FleetIcon(props: IconSvgProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 3v13" />
      <path d="M12 4.5 18.5 13H12" />
      <path d="M12 7.5 7 13h5" />
      <path d="M3 16h18l-2.1 3.5a2 2 0 0 1-1.7 1H6.8a2 2 0 0 1-1.7-1Z" />
    </svg>
  );
}
