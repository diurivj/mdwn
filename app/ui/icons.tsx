import type { ReactNode, SVGProps } from "react";

import { cx } from "./cx";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { strokeWidth?: number };

/** Decorative 24px line icons drawn for mdwn; they inherit size and color from their text. */
function icon(name: string, paths: ReactNode) {
  function Icon({ className, strokeWidth = 1.75, ...props }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className={cx("size-4 shrink-0", `icon-${name}`, className)}
        {...props}
      >
        {paths}
      </svg>
    );
  }
  Icon.displayName = `Icon(${name})`;
  return Icon;
}

export const ArrowRightIcon = icon(
  "arrow",
  <>
    <path d="M5 12h14" />
    <path d="m13 6 6 6-6 6" />
  </>,
);

export const ArrowUpIcon = icon(
  "arrow-up",
  <>
    <path d="M12 19V5" />
    <path d="m6 11 6-6 6 6" />
  </>,
);

export const ArrowDownIcon = icon(
  "arrow-down",
  <>
    <path d="M12 5v14" />
    <path d="m6 13 6 6 6-6" />
  </>,
);

export const ChevronRightIcon = icon("chevron-right", <path d="m9 6 6 6-6 6" />);

export const MenuIcon = icon("menu", <path d="M4 7h16M4 12h16M4 17h16" />);

export const CloseIcon = icon("close", <path d="M6 6l12 12M18 6 6 18" />);

export const PlusIcon = icon("plus", <path d="M12 5v14M5 12h14" />);

export const CheckIcon = icon("check", <path d="m5 12.5 4.5 4.5L19 7.5" />);

export const FolderIcon = icon(
  "folder",
  <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />,
);

export const FolderPlusIcon = icon(
  "folder-plus",
  <>
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M12 11v5M9.5 13.5h5" />
  </>,
);

export const FileIcon = icon(
  "file",
  <>
    <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z" />
    <path d="M14 3v4h4M9 12.5h6M9 16h4" />
  </>,
);

export const FilePlusIcon = icon(
  "file-plus",
  <>
    <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z" />
    <path d="M14 3v4h4M12 11v6M9 14h6" />
  </>,
);

export const LockIcon = icon(
  "lock",
  <>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </>,
);

export const KeyIcon = icon(
  "key",
  <>
    <circle cx="8" cy="15" r="4" />
    <path d="m10.8 12.2 8.2-8.2M16 7l2.5 2.5M13.5 9.5 15.5 11.5" />
  </>,
);

export const ShieldIcon = icon(
  "shield",
  <>
    <path d="M12 3 19 6v5.5c0 4.4-2.9 7.9-7 9.5-4.1-1.6-7-5.1-7-9.5V6z" />
    <path d="m9 12 2 2 4-4" />
  </>,
);

export const ShareIcon = icon(
  "share",
  <>
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6" />
  </>,
);

export const GlobeIcon = icon(
  "globe",
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z" />
  </>,
);

export const CommentIcon = icon("comment", <path d="M20 11.5a8 8 0 0 1-11.6 7.1L4 20l1.4-4.1A8 8 0 1 1 20 11.5z" />);

export const DownloadIcon = icon("download", <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />);

export const UploadIcon = icon("upload", <path d="M12 16V5M7 9l5-5 5 5M5 20h14" />);

export const PencilIcon = icon(
  "pencil",
  <>
    <path d="M15.5 4.5 19.5 8.5 9 19H5v-4z" />
    <path d="m13.5 6.5 4 4" />
  </>,
);

export const TrashIcon = icon(
  "trash",
  <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />,
);

export const MoveIcon = icon(
  "move",
  <>
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M8.5 13.5h7M13 11l2.5 2.5L13 16" />
  </>,
);

export const CopyIcon = icon(
  "copy",
  <>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
  </>,
);

export const ExternalLinkIcon = icon(
  "external",
  <path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />,
);

export const UserIcon = icon(
  "user",
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </>,
);

export const SignOutIcon = icon(
  "sign-out",
  <path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4H9M16 16l4-4-4-4M20 12H9" />,
);

export const DevicesIcon = icon(
  "devices",
  <>
    <path d="M5 6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5V15H5z" />
    <path d="M3 18h18" />
  </>,
);

export const EyeIcon = icon(
  "eye",
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

export const HeartIcon = icon(
  "heart",
  <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
);

export const RefreshIcon = icon("refresh", <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />);

export const QrIcon = icon(
  "qr",
  <>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2" />
  </>,
);
